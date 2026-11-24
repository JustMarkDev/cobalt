import { outsidePaths, touchedFiles } from './paths'
import type { RuleMode } from './policy-file'
import type { CustomRuleRec } from './domain/records'

/** Changes past this many lines are flagged as large. */
export const BIG_CHANGE = 400

export const policyRules: ReadonlyArray<{
  id: string
  name: string
  mode: RuleMode
  when: string
  requires: Array<string>
}> = [
  {
    id: 'ci-evidence',
    name: 'Tests pass on the tree that will land',
    mode: 'enforce',
    when: 'any change',
    requires: ['ci/test passed, bound to the landing tree'],
  },
  {
    id: 'findings',
    name: 'No open high-severity findings',
    mode: 'enforce',
    when: 'any change',
    requires: ['every high finding resolved or dismissed with a reason'],
  },
  {
    id: 'reviewed',
    name: 'Reviewed by someone other than the author',
    mode: 'dry-run',
    when: 'any change',
    requires: ['1 approval from an account other than the author'],
  },
]

export function approvalsOf(
  reviews: ReadonlyArray<{
    state: string
    carries: boolean
    actor: { handle: string }
  }>,
  author: string,
  assumed: ReadonlyArray<string> = [],
): Set<string> {
  const out = new Set<string>()
  for (const r of reviews)
    if (r.state === 'approved' && r.carries && r.actor.handle !== author)
      out.add(r.actor.handle)
  for (const h of assumed) if (h !== author) out.add(h)
  return out
}

export function reviewedRequirement(
  approvals: ReadonlySet<string>,
  objections: ReadonlyArray<{ id: string; actor: { handle: string } }>,
) {
  return {
    id: 'reviewed',
    rule: 'Reviewed by someone other than the author',
    state: objections.length
      ? ('fail' as const)
      : approvals.size
        ? ('pass' as const)
        : ('pending' as const),
    detail: objections.length
      ? `${objections.map((r) => r.actor.handle).join(', ')} asked for changes.`
      : approvals.size
        ? `${[...approvals].join(', ')} approved.`
        : 'No approval from anyone but the author yet.',
    needs: { approval: { min: 1 }, not_author: true },
    blocking: objections.map((r) => r.id),
  }
}

export function rulesReadChangedFiles(
  rules: ReadonlyArray<{ kind: string }>,
): boolean {
  return rules.some(
    (r) =>
      r.kind === 'path_approval' ||
      r.kind === 'max_lines' ||
      r.kind === 'allowed_paths',
  )
}

export function allowedPathsRequirement(
  r: { id: string; name: string; paths?: Array<string> },
  head: {
    files: Record<string, unknown>
    contents?: Record<string, unknown> | null
  },
) {
  const globs = r.paths ?? []
  const outside = outsidePaths(touchedFiles(head), globs)
  const shown = outside.slice(0, 3).join(', ')
  return {
    id: r.id,
    rule: r.name,
    state: outside.length ? ('fail' as const) : ('pass' as const),
    detail: outside.length
      ? `Touches ${shown}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}, outside ${globs.join(', ')}.`
      : `Touches only ${globs.join(', ')}.`,
    needs: outside.length
      ? { paths: globs, outside: outside.slice(0, 20) }
      : null,
    blocking: [],
  }
}

/** What a custom rule applies to and requires, as the policy page shows it. */
export function describeCustomRule(r: CustomRuleRec) {
  if (r.kind === 'required_check')
    return {
      when: 'any change',
      requires: [`${r.check} passed, bound to the landing tree`],
    }
  if (r.kind === 'max_lines')
    return {
      when: 'any change',
      requires: [`at most ${r.maxLines} lines added and removed`],
    }
  if (r.kind === 'allowed_paths')
    return {
      when: 'any change',
      requires: [`touches only ${(r.paths ?? []).join(', ')}`],
    }
  const n = r.approvals ?? 1
  return {
    when: `paths ${(r.paths ?? []).join(', ')}`,
    requires: [
      `${n} approval${n === 1 ? '' : 's'}, human${r.from?.length ? `, from ${r.from.join(', ')}` : ''}`,
    ],
  }
}
