import { apiError } from '../problem'
import type { CursorPosition } from '../cursor'
import type { RepoRec, Viewer } from './records'
import { DomainInsights } from './insights'

import { DAY, presentProfile } from '../profile'

export type AccountPrefs = {
  combined_total: boolean
  private_totals: boolean
  show_activity: boolean
  show_agents: boolean
  searchable: boolean
  download_target: {
    os: 'macos' | 'windows' | 'linux'
    arch: 'arm64' | 'x64'
  } | null
}

export const defaultAccountPrefs: AccountPrefs = {
  combined_total: true,
  private_totals: true,
  show_activity: true,
  show_agents: true,
  searchable: true,
  download_target: null,
}

type Contribution = {
  kind: 'push' | 'review' | 'change' | 'issue' | 'release'
  at: number
  title: string
  repo: RepoRec
  agent?: boolean
}

export abstract class DomainPeople extends DomainInsights {
  readonly accountPrefs = new Map<string, AccountPrefs>()
  readonly following = new Map<string, Set<string>>()
  peopleRev = 0

  prefsOf(handle: string): AccountPrefs {
    return this.accountPrefs.get(handle) ?? defaultAccountPrefs
  }

  private signedIn(p: Viewer) {
    if (!p) throw apiError('unauthenticated', 'Sign in first.')
    return p.handle
  }

  private person(handle: string) {
    const a =
      this.accounts.get(handle) ?? this.accounts.get(handle.toLowerCase())
    if (!a) throw apiError('not_found', `No account ${handle}.`)
    return a
  }

  async getAccountPrefs(p: Viewer) {
    return {
      object: 'account_preferences' as const,
      ...this.prefsOf(this.signedIn(p)),
    }
  }

  async updateAccountPrefs(p: Viewer, body: Partial<AccountPrefs>) {
    const h = this.signedIn(p)
    const next = { ...this.prefsOf(h) }
    for (const [k, v] of Object.entries(body) as Array<[string, unknown]>)
      if (v !== undefined) (next as Record<string, unknown>)[k] = v
    this.accountPrefs.set(h, next)
    this.peopleRev++
    this.svc.search.reset()
    return { object: 'account_preferences' as const, ...next }
  }

  private followersOf(handle: string) {
    const out: Array<string> = []
    for (const [who, set] of this.following) if (set.has(handle)) out.push(who)
    return out.sort()
  }

  seedFollow(who: string, whom: string) {
    const set = this.following.get(who) ?? new Set()
    set.add(whom)
    this.following.set(who, set)
  }

  async follow(p: Viewer, handle: string, on: boolean) {
    const me = this.signedIn(p)
    const a = this.person(handle)
    if (a.handle === me)
      throw apiError('invalid_request', 'You cannot follow yourself.')
    const set = this.following.get(me) ?? new Set()
    if (on) set.add(a.handle)
    else set.delete(a.handle)
    this.following.set(me, set)
    this.peopleRev++
  }

  private ref(handle: string) {
    const a = this.accounts.get(handle)
    return {
      object: 'account_ref' as const,
      handle,
      name: a?.name ?? handle,
      kind: a?.kind ?? ('person' as const),
      html_url: `${this.urls.html}/${handle}`,
    }
  }

  async listFollows(
    handle: string,
    which: 'followers' | 'following',
    q: { after: CursorPosition | null; limit: number },
  ) {
    const a = this.person(handle)
    const all =
      which === 'followers'
        ? this.followersOf(a.handle)
        : [...(this.following.get(a.handle) ?? [])].sort()
    let start = 0
    if (q.after) {
      const k = all.indexOf(q.after.id)
      start = k >= 0 ? k + 1 : all.length
    }
    const items = all.slice(start, start + q.limit)
    const last = items.at(-1)
    return {
      items: items.map((h) => this.ref(h)),
      next:
        start + q.limit < all.length && last
          ? { key: start + q.limit, id: last }
          : null,
    }
  }

  async peopleVersion(_p: Viewer) {
    return `ppl${this.peopleRev}.${this.accessRevision}.${this.accounts.size}`
  }

  private async contributions(handle: string, p: Viewer, since: number) {
    const prefs = this.prefsOf(handle)
    const own = p?.handle === handle
    const shown: Array<Contribution> = []
    let hidden = 0
    const email = `${handle}@users.cobaltforge.dev`
    for (const r of this.repos.values()) {
      const readable = this.canRead(r, p)
      if (!readable && !(own || prefs.private_totals)) continue
      const found: Array<Contribution> = []
      let commits: Awaited<ReturnType<typeof this.svc.git.commits>> = []
      try {
        commits = await this.svc.git.commits(`${r.owner}/${r.name}`, 1000)
      } catch {
        commits = []
      }
      for (const c of commits) {
        const at = Date.parse(c.date)
        if (at >= since && c.author.email.toLowerCase() === email)
          found.push({
            kind: 'push',
            at,
            title: c.message.split('\n')[0],
            repo: r,
          })
      }
      for (const c of r.changes.values()) {
        if (c.author.handle === handle && c.created >= since)
          found.push({
            kind: 'change',
            at: c.created,
            title: `Opened #${c.number} ${c.title}`,
            repo: r,
          })
        for (const v of c.reviews)
          if (v.actor.handle === handle && v.created >= since)
            found.push({
              kind: 'review',
              at: v.created,
              title: `Reviewed #${c.number} ${c.title}`,
              repo: r,
              agent: !!c.patchSets.at(-1)?.via?.model && v.state === 'approved',
            })
      }
      for (const i of r.issues.values())
        if (i.author.handle === handle && i.created >= since)
          found.push({
            kind: 'issue',
            at: i.created,
            title: `Opened issue #${i.number} ${i.title}`,
            repo: r,
          })
      for (const x of r.releases ?? [])
        if (x.author.handle === handle && x.published >= since)
          found.push({
            kind: 'release',
            at: x.published,
            title: `Published ${x.tag}`,
            repo: r,
          })
      if (readable) shown.push(...found)
      else hidden += found.length
    }
    return { shown, hidden }
  }

  async profile(handle: string, p: Viewer) {
    const a = this.person(handle)
    const now = this.now()
    const prefs = this.prefsOf(a.handle)
    const own = p?.handle === a.handle
    const yearAgo = now - 365 * DAY
    const { shown, hidden } =
      a.kind === 'person'
        ? await this.contributions(a.handle, p, yearAgo)
        : { shown: [], hidden: 0 }
    const owned = [...this.repos.values()].filter(
      (r) => r.owner === a.handle && this.canRead(r, p),
    )
    return presentProfile({
      person: a,
      now,
      own,
      prefs,
      shown,
      hidden,
      owned,
      keyOf: (r) => r,
      releases: owned.reduce((n, r) => n + (r.releases?.length ?? 0), 0),
      downloads: owned.reduce(
        (n, r) =>
          n +
          (r.releases ?? []).reduce(
            (m, x) => m + x.assets.reduce((k, s) => k + s.downloads, 0),
            0,
          ),
        0,
      ),
      followers: this.followersOf(a.handle).length,
      following: this.following.get(a.handle)?.size ?? 0,
      viewerFollows:
        p && p.handle !== a.handle
          ? (this.following.get(p.handle)?.has(a.handle) ?? false)
          : null,
    })
  }

  async profileVersion(handle: string, p: Viewer) {
    const a = this.person(handle)
    let rev = 0
    for (const r of this.repos.values()) rev += r.rev
    return `${a.id}.${a.version}.${rev}.${this.peopleRev}.${this.accessRevision}.${Math.floor(this.now() / DAY)}.${p?.handle ?? '-'}`
  }

  async listPeople(
    p: Viewer,
    q: { q?: string; after: CursorPosition | null; limit: number },
  ) {
    const needle = q.q?.trim().toLowerCase() ?? ''
    const all = [...this.accounts.values()]
      .filter(
        (a) =>
          a.kind === 'person' &&
          (this.prefsOf(a.handle).searchable || a.handle === p?.handle) &&
          (!needle ||
            a.handle.toLowerCase().includes(needle) ||
            a.name.toLowerCase().includes(needle) ||
            a.bio.toLowerCase().includes(needle)),
      )
      .map((a) => ({
        a,
        followers: this.followersOf(a.handle).length,
        repos: [...this.repos.values()].filter(
          (r) => r.owner === a.handle && r.visibility === 'public',
        ),
      }))
      .sort(
        (x, y) =>
          y.followers - x.followers || x.a.handle.localeCompare(y.a.handle),
      )
    let start = 0
    if (q.after) {
      const k = all.findIndex((x) => x.a.handle === q.after!.id)
      start = k >= 0 ? k + 1 : all.length
    }
    const items = all.slice(start, start + q.limit)
    const last = items.at(-1)
    return {
      items: items.map(({ a, followers, repos }) => {
        const langs = new Map<string, number>()
        for (const r of repos)
          for (const [name, pct] of r.languages)
            langs.set(name, (langs.get(name) ?? 0) + pct * (r.stars + 1))
        return {
          object: 'person' as const,
          handle: a.handle,
          name: a.name,
          bio: a.bio,
          followers,
          repositories: repos.length,
          stars: repos.reduce((n, r) => n + r.stars, 0),
          languages: [...langs.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([name]) => name),
          html_url: `${this.urls.html}/${a.handle}`,
          viewer_follows:
            p && p.handle !== a.handle
              ? (this.following.get(p.handle)?.has(a.handle) ?? false)
              : null,
        }
      }),
      next:
        start + q.limit < all.length && last
          ? { key: start + q.limit, id: last.a.handle }
          : null,
    }
  }
}
