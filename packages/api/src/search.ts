import { pageSorted } from './cursor'
import type { CursorPosition } from './cursor'
import type { EventLog, EventRecord } from './events'

export type SearchDoc = {
  key: string
  type: 'change' | 'issue' | 'repo'
  id: string
  repo: string
  number: number | null
  title: string
  text: string
  state: string
  author: string
  labels: Array<string>
  updated: number
  url: string
}

export type SearchHit = {
  doc: SearchDoc
  score: number
  snippet: string
  shown?: true
}

const fragments = new WeakMap<SearchDoc, { head: string; tail: string }>()
export function fragmentsOf(doc: SearchDoc, iso: (ms: number) => string) {
  let f = fragments.get(doc)
  if (!f) {
    f = {
      head: `{"object":"search_result","type":${JSON.stringify(doc.type)},"id":${JSON.stringify(doc.id)},"number":${doc.number},"repo":${JSON.stringify(doc.repo)},"title":${JSON.stringify(doc.title)},"state":${JSON.stringify(doc.state)},"snippet":`,
      tail: `,"url":${JSON.stringify(doc.url)},"updated_at":${JSON.stringify(iso(doc.updated))}}`,
    }
    fragments.set(doc, f)
  }
  return f
}

const WORD = /[\p{L}\p{N}]+/gu
const words = (s: string) =>
  (s.toLowerCase().match(WORD) ?? []).filter(
    (w) => w.length >= 2 || /^\d$/.test(w),
  )

export type ParsedQuery = {
  terms: Array<string>
  phrases: Array<string>
  types: Array<string>
  repo: Array<string>
  state: Array<string>
  author: Array<string>
  label: Array<string>
}

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = {
    terms: [],
    phrases: [],
    types: [],
    repo: [],
    state: [],
    author: [],
    label: [],
  }
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1]) {
      out.phrases.push(m[1].toLowerCase())
      out.terms.push(...words(m[1]))
      continue
    }
    const tok = m[2]
    const qual = /^(type|repo|state|author|label|is):(.+)$/i.exec(tok)
    if (qual) {
      const k = qual[1].toLowerCase()
      const v = qual[2].replace(/^"|"$/g, '')
      if (
        k === 'is' &&
        ['open', 'closed', 'merged', 'draft'].includes(v.toLowerCase())
      )
        out.state.push(v)
      else if (k === 'type' || k === 'is') out.types.push(v.toLowerCase())
      else out[k as 'repo' | 'state' | 'author' | 'label'].push(v)
    } else out.terms.push(...words(tok.replace(/^#/, '')))
  }
  return out
}

function termsOf(d: SearchDoc): Set<string> {
  const out = new Set<string>()
  for (const w of words(d.title)) out.add(w)
  for (const w of words(d.text)) out.add(w)
  if (d.number !== null) out.add(String(d.number))
  for (const w of words(d.repo)) out.add(w)
  return out
}

const has = (list: Array<number>, x: number) => {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo < list.length && list[lo] === x
}

function insert(list: Array<number>, x: number) {
  if (list.length === 0 || list[list.length - 1] < x) return void list.push(x)
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < x) lo = mid + 1
    else hi = mid
  }
  if (list[lo] !== x) list.splice(lo, 0, x)
}

function erase(list: Array<number>, x: number) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid] < x) lo = mid + 1
    else hi = mid
  }
  if (list[lo] === x) list.splice(lo, 1)
}

const CHANGE_LOG = 256
const CACHE_HITS = 150_000

export class SearchIndex {
  private readonly slots: Array<SearchDoc | null> = []
  private readonly numberOf = new Map<string, number>()
  private readonly terms = new Map<string, Array<number>>()
  private readonly byRepo = new Map<string, Array<number>>()
  private live = 0
  private vocab: Array<string> = []
  private vocabNew: Array<string> = []
  private built = false
  version = 0
  private readonly changes: Array<{
    v: number
    before: SearchDoc | null
    after: SearchDoc | null
  }> = []
  private readonly cache = new Map<
    string,
    { version: number; hits: Array<SearchHit>; q: ParsedQuery }
  >()
  private cachedHits = 0
  private off: (() => void) | null = null

  constructor(
    private readonly source: () => Iterable<SearchDoc>,
    private readonly events: EventLog,
  ) {}

  ensure() {
    if (this.built) return
    this.built = true
    for (const d of this.source()) this.upsert(d)
    this.off = this.events.subscribe((e) => {
      const d = docFromEvent(e)
      if (d) this.upsert(d)
    })
  }

  upsertIfBuilt(doc: SearchDoc) {
    if (this.built) this.upsert(doc)
  }

  dispose() {
    this.off?.()
  }

  reset() {
    this.off?.()
    this.off = null
    this.slots.length = 0
    this.numberOf.clear()
    this.terms.clear()
    this.byRepo.clear()
    this.vocab = []
    this.vocabNew = []
    this.changes.length = 0
    this.cache.clear()
    this.cachedHits = 0
    this.live = 0
    this.built = false
    this.version++
  }

  get size() {
    return this.live
  }

  upsert(doc: SearchDoc) {
    const known = this.numberOf.get(doc.key)
    const before = known === undefined ? null : this.slots[known]
    let n: number
    if (known === undefined) {
      n = this.slots.length
      this.slots.push(doc)
      this.numberOf.set(doc.key, n)
      this.live++
    } else {
      n = known
      this.slots[n] = doc
    }
    const now = termsOf(doc)
    const was = before ? termsOf(before) : null
    if (was) for (const t of was) if (!now.has(t)) this.unlink(t, n)
    for (const t of now) {
      if (was?.has(t)) continue
      let list = this.terms.get(t)
      if (!list) {
        this.terms.set(t, (list = []))
        this.vocabNew.push(t)
      }
      insert(list, n)
    }
    if (!before || before.repo !== doc.repo) {
      if (before) this.unlinkRepo(before.repo, n)
      let r = this.byRepo.get(doc.repo)
      if (!r) this.byRepo.set(doc.repo, (r = []))
      insert(r, n)
    }
    this.record(before, doc)
  }

  private unlink(term: string, n: number) {
    const list = this.terms.get(term)
    if (!list) return
    erase(list, n)
    if (list.length === 0) {
      this.terms.delete(term)
    }
  }

  private unlinkRepo(repo: string, n: number) {
    const r = this.byRepo.get(repo)
    if (!r) return
    erase(r, n)
    if (r.length === 0) this.byRepo.delete(repo)
  }

  private record(before: SearchDoc | null, after: SearchDoc | null) {
    this.version++
    this.changes.push({ v: this.version, before, after })
    if (this.changes.length > CHANGE_LOG * 2)
      this.changes.splice(0, this.changes.length - CHANGE_LOG)
  }

  private prefix(p: string): Array<number> {
    if (this.vocabNew.length) {
      if (this.vocabNew.length > 512) {
        this.vocab = mergeSorted(
          this.vocab.filter((w) => this.terms.has(w)),
          [...new Set(this.vocabNew)].filter((w) => this.terms.has(w)).sort(),
        )
        this.vocabNew = []
      }
    }
    const lists: Array<Array<number>> = []
    let lo = 0
    let hi = this.vocab.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.vocab[mid] < p) lo = mid + 1
      else hi = mid
    }
    for (
      let i = lo;
      i < this.vocab.length && this.vocab[i].startsWith(p);
      i++
    ) {
      const l = this.terms.get(this.vocab[i])
      if (l) lists.push(l)
    }
    for (const w of this.vocabNew) {
      if (w.startsWith(p)) {
        const l = this.terms.get(w)
        if (l && !lists.includes(l)) lists.push(l)
      }
    }
    if (lists.length === 1) return lists[0]
    return [...new Set(lists.flat())].sort((a, b) => a - b)
  }

  private matches(q: ParsedQuery, d: SearchDoc): boolean {
    if (q.terms.length) {
      const own = termsOf(d)
      for (let i = 0; i < q.terms.length; i++) {
        const t = q.terms[i]
        if (i < q.terms.length - 1) {
          if (!own.has(t)) return false
        } else {
          let any = false
          for (const w of own)
            if (w.startsWith(t)) {
              any = true
              break
            }
          if (!any) return false
        }
      }
    } else if (q.repo.length && !q.repo.includes(d.repo)) return false
    return this.score(q, d, wantedTypes(q)) !== null
  }

  private score(
    q: ParsedQuery,
    d: SearchDoc,
    wantTypes: Array<string> | null,
  ): number | null {
    if (wantTypes && !wantTypes.includes(d.type)) return null
    if (q.repo.length && !q.repo.includes(d.repo)) return null
    if (q.state.length && !q.state.includes(d.state)) return null
    if (q.author.length && !q.author.includes(d.author)) return null
    if (q.label.length && !q.label.every((l) => d.labels.includes(l)))
      return null
    if (q.terms.length === 0 && q.phrases.length === 0) return 1
    const title = d.title.toLowerCase()
    if (q.phrases.length) {
      const body = d.text.toLowerCase()
      if (q.phrases.some((p) => !title.includes(p) && !body.includes(p)))
        return null
    }
    if (q.terms.length === 0) return 1
    let inTitle = 0
    for (const t of q.terms) if (title.includes(t)) inTitle++
    return inTitle === q.terms.length ? 3 : inTitle > 0 ? 2 : 1
  }

  private snippetOf(q: ParsedQuery, d: SearchDoc): string {
    const firstTerm = q.terms[0]
    if (!firstTerm) return ''
    const at = d.text.toLowerCase().indexOf(firstTerm)
    if (at < 0 || d.title.toLowerCase().includes(firstTerm)) return ''
    return d.text
      .slice(Math.max(0, at - 40), at + 100)
      .replace(/\s+/g, ' ')
      .trim()
  }

  search(
    q: ParsedQuery,
    canSee: (repo: string) => boolean,
    viewer: string,
  ): Array<SearchHit> {
    this.ensure()
    const cacheKey = `${viewer}|${JSON.stringify(q)}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      const visible = () => cached.hits.filter((h) => canSee(h.doc.repo))
      if (cached.version === this.version) return visible()
      const floor = this.changes.length ? this.changes[0].v : this.version + 1
      if (cached.version + 1 >= floor) {
        let touched = false
        for (const ch of this.changes) {
          if (ch.v <= cached.version) continue
          if (
            (ch.before && this.matches(q, ch.before)) ||
            (ch.after && this.matches(q, ch.after))
          ) {
            touched = true
            break
          }
        }
        if (!touched) {
          cached.version = this.version
          return visible()
        }
      }
    }

    let candidates: Iterable<number>
    if (q.terms.length) {
      const lists = q.terms.map((t, i) =>
        i === q.terms.length - 1 ? this.prefix(t) : (this.terms.get(t) ?? []),
      )
      lists.sort((a, b) => a.length - b.length)
      const [first, ...rest] = lists
      candidates = rest.length
        ? first.filter((n) => rest.every((l) => has(l, n)))
        : first
    } else if (q.repo.length) {
      candidates = [...new Set(q.repo.flatMap((r) => this.byRepo.get(r) ?? []))]
    } else candidates = this.slots.keys()

    const hits: Array<SearchHit> = []
    const wanted = wantedTypes(q)
    for (const n of candidates) {
      const d = this.slots[n]
      if (!d || !canSee(d.repo)) continue
      const score = this.score(q, d, wanted)
      if (score !== null) hits.push({ doc: d, score, snippet: '' })
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.doc.updated - a.doc.updated ||
        (a.doc.key < b.doc.key ? 1 : -1),
    )
    if (cached) this.cachedHits -= cached.hits.length
    this.cache.delete(cacheKey)
    this.cache.set(cacheKey, { version: this.version, hits, q })
    this.cachedHits += hits.length
    while (
      (this.cache.size > 64 || this.cachedHits > CACHE_HITS) &&
      this.cache.size > 1
    ) {
      const oldest = this.cache.keys().next().value as string
      this.cachedHits -= this.cache.get(oldest)!.hits.length
      this.cache.delete(oldest)
    }
    return hits
  }

  page(
    hits: Array<SearchHit>,
    limit: number,
    after: CursorPosition | null,
    q?: ParsedQuery,
  ) {
    const page = this.pageOf(hits, limit, after)
    if (q)
      for (const h of page.items)
        if (!h.shown) {
          h.snippet = this.snippetOf(q, h.doc)
          h.shown = true
        }
    return page
  }

  private pageOf(
    hits: Array<SearchHit>,
    limit: number,
    after: CursorPosition | null,
  ) {
    return pageSorted(
      hits,
      (h) => h.score * 1e13 + h.doc.updated,
      (h) => h.doc.key,
      { limit, after, desc: true, stored: 'desc' },
    )
  }
}

export function docFromEvent(e: EventRecord): SearchDoc | null {
  const d = e.data as Record<string, any> | null
  if (!d || (d.object !== 'change' && d.object !== 'issue')) return null
  return {
    key: `${d.object}:${d.id}`,
    type: d.object,
    id: d.id,
    repo: d.repo?.full_name ?? e.repo ?? '',
    number: d.number,
    title: d.title,
    text: d.object === 'change' ? d.description : d.body,
    state: d.state,
    author: d.author?.handle ?? '',
    labels: d.labels ?? [],
    updated: Date.parse(d.updated_at),
    url: d.url,
  }
}

function wantedTypes(q: ParsedQuery): Array<string> | null {
  return q.types.length ? q.types.map((t) => t.replace(/s$/, '')) : null
}

function mergeSorted(a: Array<string>, b: Array<string>): Array<string> {
  const out: Array<string> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) out.push(a[i++])
    else if (a[i] > b[j]) out.push(b[j++])
    else {
      out.push(a[i++])
      j++
    }
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}
