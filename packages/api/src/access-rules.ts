import { globMatcher } from './glob'

export type AccessRule = {
  id: string
  kind: 'branch' | 'path'
  patterns: Array<string>
  readers: Array<string>
  createdBy: string
  created: number
}

export const MAX_ACCESS_RULES = 20
export const MAX_RULE_PATTERNS = 20
export const MAX_RULE_READERS = 50

export type RuleViewer = {
  handle: string
  teams: ReadonlySet<string>
  all: boolean
}

export function readsRule(rule: AccessRule, v: RuleViewer | null) {
  if (!v) return false
  if (v.all) return true
  return rule.readers.some((r) =>
    r.startsWith('team:') ? v.teams.has(r.slice(5)) : r === v.handle,
  )
}

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

export function branchHidden(
  hidden: ReadonlyArray<Pick<AccessRule, 'kind' | 'patterns'>>,
  branch: string,
) {
  return hidden.some((r) => r.kind === 'branch' && matchAny(r.patterns)(branch))
}

export function pathHidden(
  hidden: ReadonlyArray<Pick<AccessRule, 'kind' | 'patterns'>>,
  path: string,
) {
  return hidden.some((r) => r.kind === 'path' && matchAny(r.patterns)(path))
}

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

export function changeVisible(
  rules: ReadonlyArray<AccessRule>,
  over: ReadonlyArray<string>,
  v: RuleViewer | null,
) {
  if (!over.length) return true
  return rules.filter((r) => over.includes(r.id)).every((r) => readsRule(r, v))
}

const PATTERN = /^[^\s\\]{1,200}$/

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
