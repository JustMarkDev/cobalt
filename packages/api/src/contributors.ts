// Who wrote the commits, as people rather than email addresses: one person
// commits as `Mark <123+JustMarkDev@users.noreply.github.com>` from the web and
// as `JustMarkDev <me@example.com>` from a laptop, and bots are not people.

export type CommitAuthor = { name: string; email: string; date: string }

export type ContributorGroup = {
  name: string
  email: string
  commits: number
  last: string
  /** GitHub logins this person is known by, from no-reply emails and names. */
  logins: Array<string>
}

const NOREPLY = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i
const BOT_NAMES =
  /^(?:github-actions|actions-user|renovate|dependabot|semantic-release|release-please|web-flow|copilot-swe-agent)$/i

/** A GitHub login read from a no-reply address, or null. */
export function loginOfEmail(email: string): string | null {
  const m = NOREPLY.exec(email.trim())
  return m && !m[1].endsWith('[bot]') ? m[1] : null
}

export function isBot(a: { name: string; email: string }): boolean {
  const name = a.name.trim()
  const email = a.email.trim().toLowerCase()
  return (
    /\[bot\]$/i.test(name) ||
    email.includes('[bot]@') ||
    /(?:^|[-_ ])bot$/i.test(name) ||
    BOT_NAMES.test(name) ||
    (email === 'noreply@github.com' && name === 'GitHub')
  )
}

/**
 * People who wrote these commits, most commits first. One person's addresses
 * are one entry when a no-reply address names the login another entry uses as
 * its name. Bots are left out.
 */
export function groupAuthors(
  authors: ReadonlyArray<CommitAuthor>,
): Array<ContributorGroup> {
  type G = ContributorGroup & { names: Map<string, number> }
  const byKey = new Map<string, G>()
  for (const a of authors) {
    if (isBot(a)) continue
    const login = loginOfEmail(a.email)
    const key = login ? `@${login.toLowerCase()}` : a.email.toLowerCase()
    let g = byKey.get(key)
    if (!g) {
      g = {
        name: a.name,
        email: a.email,
        commits: 0,
        last: a.date,
        logins: login ? [login] : [],
        names: new Map(),
      }
      byKey.set(key, g)
    }
    g.commits++
    if (a.date > g.last) g.last = a.date
    g.names.set(a.name, (g.names.get(a.name) ?? 0) + 1)
  }
  // `JustMarkDev <me@example.com>` is the person behind
  // `123+JustMarkDev@users.noreply.github.com`.
  for (const [key, g] of byKey) {
    if (key.startsWith('@')) continue
    const top = [...g.names.keys()].find(
      (n) => LOGIN.test(n) && byKey.has(`@${n.toLowerCase()}`),
    )
    if (!top) continue
    const into = byKey.get(`@${top.toLowerCase()}`)!
    mergeInto(into, g)
    byKey.delete(key)
  }
  return [...byKey.values()].map(finish).sort(byCommits)
}

/** Merge groups that turned out to be one account (`handleOf` by login). */
export function mergeByHandle(
  groups: ReadonlyArray<ContributorGroup>,
  handleOf: (g: ContributorGroup) => string | null,
): Array<ContributorGroup & { handle: string | null }> {
  const out = new Map<string, ContributorGroup & { handle: string | null }>()
  for (const g of groups) {
    const handle = handleOf(g)
    const key = handle ? `~${handle}` : `${g.email.toLowerCase()}`
    const had = out.get(key)
    if (!had) {
      out.set(key, { ...g, handle })
      continue
    }
    const keepName = had.commits >= g.commits ? had : g
    had.name = keepName.name
    had.email = keepName.email
    had.commits += g.commits
    if (g.last > had.last) had.last = g.last
    had.logins = [...new Set([...had.logins, ...g.logins])]
  }
  return [...out.values()].sort(byCommits)
}

/** Candidate logins of a group: its no-reply logins and login-shaped names. */
export function loginsOf(g: ContributorGroup): Array<string> {
  return [...new Set([...g.logins, ...(LOGIN.test(g.name) ? [g.name] : [])])]
}

function mergeInto(
  into: ContributorGroup & { names: Map<string, number> },
  g: ContributorGroup & { names: Map<string, number> },
) {
  into.commits += g.commits
  if (g.last > into.last) into.last = g.last
  for (const [n, k] of g.names) into.names.set(n, (into.names.get(n) ?? 0) + k)
  // Keep a real address over the no-reply one.
  into.email = g.email
}

function finish(g: ContributorGroup & { names: Map<string, number> }) {
  const name = [...g.names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.name
  return {
    name,
    email: g.email,
    commits: g.commits,
    last: g.last,
    logins: g.logins,
  }
}

const byCommits = (a: ContributorGroup, b: ContributorGroup) =>
  b.commits - a.commits || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
