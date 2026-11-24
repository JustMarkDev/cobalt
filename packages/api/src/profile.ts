// A person's public profile, from the contributions the viewer may see.
// Pure, so the memory domain and `convex/` give the same object.

export const DAY = 86_400_000
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

type RepoLike = {
  owner: string
  name: string
  languages: ReadonlyArray<ReadonlyArray<string | number>>
}

export type Contribution<R extends RepoLike, K extends string = string> = {
  kind: K
  at: number
  title: string
  repo: R
  agent?: boolean
}

export function presentProfile<
  R extends RepoLike,
  A extends string,
  K extends string,
>(a: {
  person: { handle: string; name: string; kind: A; bio: string }
  now: number
  own: boolean
  prefs: {
    show_agents: boolean
    show_activity: boolean
    private_totals: boolean
  }
  /** Contributions in the last year the viewer may see, and how many they may not. */
  shown: Array<Contribution<R, K>>
  hidden: number
  /** The repositories the person owns that the viewer may see. */
  owned: ReadonlyArray<R>
  /** Identifies a repository across `shown` and `owned`. */
  keyOf: (r: R) => unknown
  releases: number
  downloads: number
  followers: number
  following: number
  viewerFollows: boolean | null
}) {
  const { shown, own, prefs, now } = a
  const all = shown.length + a.hidden
  const end = new Date(now)
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11 + i, 1),
    )
    return { month: d.toISOString().slice(0, 7), count: 0 }
  })
  const days = Array.from({ length: 26 * 7 }, () => 0)
  const today = Math.floor(now / DAY)
  const weekday = WEEKDAYS.map((day) => ({ day, commits: 0, reviews: 0 }))
  const kinds: Record<string, number> = {
    push: 0,
    review: 0,
    change: 0,
    issue: 0,
    release: 0,
  }
  for (const c of shown) {
    const m = months.find(
      (x) => x.month === new Date(c.at).toISOString().slice(0, 7),
    )
    if (m) m.count++
    const k = days.length - 1 - (today - Math.floor(c.at / DAY))
    if (k >= 0 && k < days.length) days[k]++
    const w = (new Date(c.at).getUTCDay() + 6) % 7
    if (c.kind === 'push') weekday[w].commits++
    if (c.kind === 'review') weekday[w].reviews++
    kinds[c.kind]++
  }
  const work = (
    [
      ['Commits', kinds.push],
      ['Reviews', kinds.review],
      ['Changes', kinds.change],
      ['Issues', kinds.issue],
      ['Releases', kinds.release],
    ] as const
  ).map(([axis, n]) => ({
    axis,
    value: shown.length ? Math.round((n / shown.length) * 100) : 0,
  }))
  const weight = new Map<unknown, { r: R; w: number }>()
  for (const c of shown) {
    const key = a.keyOf(c.repo)
    const x = weight.get(key) ?? { r: c.repo, w: 0 }
    x.w++
    weight.set(key, x)
  }
  for (const r of a.owned)
    if (!weight.has(a.keyOf(r))) weight.set(a.keyOf(r), { r, w: 1 })
  const langs = new Map<string, number>()
  for (const { r, w } of weight.values())
    for (const [name, pct] of r.languages)
      langs.set(
        name as string,
        (langs.get(name as string) ?? 0) + (pct as number) * w,
      )
  const langTotal = [...langs.values()].reduce((x, y) => x + y, 0) || 1
  const reviewed = shown.filter((c) => c.kind === 'review')
  const showAgents = own || prefs.show_agents
  const showActivity = own || prefs.show_activity
  return {
    object: 'profile' as const,
    handle: a.person.handle,
    name: a.person.name,
    kind: a.person.kind,
    bio: a.person.bio,
    followers: a.followers,
    following: a.following,
    viewer_follows: a.viewerFollows,
    contributions: {
      total: own || prefs.private_totals ? all : shown.length,
      private: own || prefs.private_totals ? a.hidden : 0,
      by_month: months,
      by_day: showActivity ? days : [],
      by_weekday: weekday,
    },
    work,
    languages: [...langs.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([name, v]) => ({
        name,
        percent: Math.round((v / langTotal) * 100),
      })),
    repositories: a.owned.length,
    releases: a.releases,
    downloads: a.downloads,
    agent_share:
      showAgents && reviewed.length
        ? Math.round(
            (reviewed.filter((c) => c.agent).length / reviewed.length) * 100,
          )
        : null,
    activity: showActivity
      ? shown
          .sort((x, y) => y.at - x.at)
          .slice(0, 30)
          .map((c) => ({
            kind: c.kind,
            title: c.title,
            repo: `${c.repo.owner}/${c.repo.name}`,
            at: new Date(c.at).toISOString(),
          }))
      : [],
    activity_hidden: !showActivity,
  }
}
