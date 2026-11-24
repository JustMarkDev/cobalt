import type { Receipt } from './via'
import { newId } from './ids'

export type ActorLike = {
  id: string
  handle: string
}

export type EventRecord = {
  object: 'event'
  id: string
  sequence: number
  type: string
  created_at: string
  repo: string | null
  repo_id: string | null
  actor: {
    object: 'actor'
    id: string
    handle: string
  }
  via: Receipt | null
  subject: { object: string; id: string; number: number | null }
  changes: Array<string>
  data: Record<string, unknown> | null
}

export function matchesType(
  patterns: ReadonlyArray<string>,
  type: string,
): boolean {
  return patterns.some(
    (p) =>
      p === '*' ||
      p === type ||
      (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  )
}

export type StoredEvent = {
  readonly sequence: number
  readonly type: string
  readonly repo: string | null
  readonly repoId: string | null
  readonly json: string
}

export function parseEvent(s: StoredEvent): EventRecord {
  return JSON.parse(s.json) as EventRecord
}

let stampMs = Number.NaN
let stampText = ''
function stamp(ms: number) {
  if (ms !== stampMs) {
    stampText = new Date(ms).toISOString()
    stampMs = ms
  }
  return stampText
}

export class EventLog {
  private events: Array<StoredEvent> = []
  private byRepo = new Map<string, Array<StoredEvent>>()
  private firstSequence = 1
  private next = 1
  private held = 0
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly listeners = new Set<(e: EventRecord) => void>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly keep = 50_000,
    private readonly maxChars = 24_000_000,
  ) {}

  get head() {
    return this.next - 1
  }

  get oldest() {
    return this.firstSequence
  }

  get size() {
    return this.held
  }

  append(
    event: Omit<EventRecord, 'object' | 'id' | 'sequence' | 'created_at'>,
  ): EventRecord {
    const at = this.now()
    const record: EventRecord = {
      object: 'event',
      id: newId('event', at),
      sequence: this.next++,
      created_at: stamp(at),
      ...event,
    }
    return this.store(record)
  }

  ingest(record: EventRecord): EventRecord | null {
    if (record.sequence < this.next) return null
    if (this.events.length === 0) this.firstSequence = record.sequence
    this.next = record.sequence + 1
    return this.store(record)
  }

  private store(record: EventRecord): EventRecord {
    const stored: StoredEvent = {
      sequence: record.sequence,
      type: record.type,
      repo: record.repo,
      repoId: record.repo_id,
      json: JSON.stringify(record),
    }
    this.held += stored.json.length
    this.events.push(stored)
    if (stored.repoId) {
      let list = this.byRepo.get(stored.repoId)
      if (!list) this.byRepo.set(stored.repoId, (list = []))
      list.push(stored)
    }
    for (const l of this.listeners) l(record)
    if (this.events.length > this.keep * 1.1 || this.held > this.maxChars * 1.1)
      this.trim()
    this.wake('*')
    if (record.repo) this.wake(`repo:${record.repo.toLowerCase()}`)
    if (record.repo_id) this.wake(`repo-id:${record.repo_id}`)
    return record
  }

  private trim() {
    let drop = 0
    let held = this.held
    while (
      drop < this.events.length - 1 &&
      (this.events.length - drop > this.keep || held > this.maxChars)
    ) {
      held -= this.events[drop].json.length
      drop++
    }
    if (drop === 0) return
    this.events = this.events.slice(drop)
    this.held = held
    this.firstSequence += drop
    for (const [repo, list] of this.byRepo) {
      let n = 0
      while (n < list.length && list[n].sequence < this.firstSequence) n++
      if (n === list.length) this.byRepo.delete(repo)
      else if (n > 0) this.byRepo.set(repo, list.slice(n))
    }
  }

  subscribe(fn: (e: EventRecord) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  since(after: number, limit: number, keep?: (e: StoredEvent) => boolean) {
    const out: Array<StoredEvent> = []
    let i = Math.max(0, after + 1 - this.firstSequence)
    let scannedTo = after
    for (; i < this.events.length && out.length < limit; i++) {
      const e = this.events[i]
      scannedTo = e.sequence
      if (!keep || keep(e)) out.push(e)
    }
    return { events: out, exhausted: i >= this.events.length, scannedTo }
  }

  all() {
    return this.events
  }

  repoEvents(repoId: string): ReadonlyArray<StoredEvent> {
    return this.byRepo.get(repoId) ?? []
  }

  wait(topic: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(topic)
      if (!set) this.waiters.set(topic, (set = new Set()))
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        if (set.size === 0 && this.waiters.get(topic) === set)
          this.waiters.delete(topic)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      set.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private wake(topic: string) {
    const set = this.waiters.get(topic)
    if (!set) return
    for (const done of Array.from(set)) done()
  }

  get waiting() {
    let n = 0
    for (const s of this.waiters.values()) n += s.size
    return n
  }
}

export function hiddenEvent(
  e: { type: string; json: string },
  hidden: ReadonlySet<number> | undefined,
) {
  if (!hidden?.size) return false
  const subject = parseEvent(e as StoredEvent).subject
  return (
    subject.number !== null &&
    (subject.object === 'change' ||
      /^(change|finding|check|ci|operation)\./.test(e.type)) &&
    hidden.has(subject.number)
  )
}
