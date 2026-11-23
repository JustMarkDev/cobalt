import { globMatcher } from './glob'

/**
 * Access rules: parts of a repository only some people may see.
 *
 *  - a **branch** rule hides branches (by glob, `secret/*`) and the changes on
 *    them: three people can work on `acquisition/*` in a repository fifty
 *    people read.
 *  - a **path** rule hides files (by glob, `finance/**`, `*.key`), and every
 *    change that touches one.
 *
 * Readers are named people and teams (`team:legal`). The repository's
 * administrators (the person who owns it, an organization's owners and
 * admins) always read everything, so a rule can never lock its owners out.
 * Organization membership alone is not enough: that is the point.
 *
 * Plain JavaScript: the memory domain, the Convex functions and the API's
 * git reads decide the same way.
 */

export type AccessRule = {
  id: string
  kind: 'branch' | 'path'
  patterns: Array<string>
  /** Handles, and `team:<slug>` for a team of the owning organization. */
  readers: Array<string>
  createdBy: string
  created: number
}

export const MAX_ACCESS_RULES = 20
export const MAX_RULE_PATTERNS = 20
export const MAX_RULE_READERS = 50

/** Who is asking, as rules see them. */
export type RuleViewer = {
  handle: string
  /** Team slugs of the owning organization the viewer is in. */
  teams: ReadonlySet<string>
  /** Administers the repository, is the system, or is a runner serving it. */
  all: boolean
}

export function readsRule(rule: AccessRule, v: RuleViewer | null) {
  if (!v) return false
  if (v.all) return true
  return rule.readers.some((r) =>
    r.startsWith('team:') ? v.teams.has(r.slice(5)) : r === v.handle,
  )
}

/** The rules a viewer may not read. Empty for administrators. */
export function hiddenRules(
  rules: ReadonlyArray<AccessRule>,
  v: RuleViewer | null,
): Array<AccessRule> {
  return rules.filter((r) => !readsRule(r, v))
}

const matchAny = (patterns: ReadonlyArray<string>) => {
  const ms = patterns.map(globMatcher)
  return (s: string) => ms.some((m) => m.test(s))
}

/** Whether a branch is hidden by any of these rules. */
export function branchHidden(
  hidden: ReadonlyArray<Pick<AccessRule, 'kind' | 'patterns'>>,
  branch: string,
) {
  return hidden.some((r) => r.kind === 'branch' && matchAny(r.patterns)(branch))
}

/** Whether a path is hidden by any of these rules. */
export function pathHidden(
  hidden: ReadonlyArray<Pick<AccessRule, 'kind' | 'patterns'>>,
  path: string,
) {
  return hidden.some((r) => r.kind === 'path' && matchAny(r.patterns)(path))
}

/** The rules a change falls under: its branch, or any file it touches. */
export function rulesOverChange(
  rules: ReadonlyArray<AccessRule>,
  c: { branch: string; files: Iterable<string> },
): Array<string> {
  const files = [...c.files]
  return rules
    .filter((r) =>
      r.kind === 'branch'
        ? matchAny(r.patterns)(c.branch)
        : files.some(matchAny(r.patterns)),
    )
    .map((r) => r.id)
}

/** Whether a viewer may see a change, given the rules it falls under. */
export function changeVisible(
  rules: ReadonlyArray<AccessRule>,
  over: ReadonlyArray<string>,
  v: RuleViewer | null,
) {
  if (!over.length) return true
  return rules.filter((r) => over.includes(r.id)).every((r) => readsRule(r, v))
}

const PATTERN = /^[^\s\\]{1,200}$/

/** Checks a rule a person wrote. Returns problems as `[pointer, message]`. */
export function ruleProblems(
  body: { kind: string; patterns: Array<string>; readers: Array<string> },
  defaultBranch: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (!body.patterns.length)
    out.push(['/body/patterns', 'Name at least one glob.'])
  for (const [i, p] of body.patterns.entries()) {
    if (!PATTERN.test(p) || p.startsWith('/') || p.split('/').includes('..'))
      out.push([
        `/body/patterns/${i}`,
        `${p} is not a glob such as secret/* or finance/**.`,
      ])
    if (body.kind === 'branch' && globMatcher(p).test(defaultBranch))
      out.push([
        `/body/patterns/${i}`,
        `${p} matches ${defaultBranch}, the default branch; a rule cannot hide it.`,
      ])
  }
  if (!body.readers.length)
    out.push([
      '/body/readers',
      'Name who may read it. Administrators always can.',
    ])
  return out
}
