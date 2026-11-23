import { outsidePaths, touchedFiles } from './paths'
import type { RuleMode } from './policy-file'

/**
 * The rules every repository starts with, shared by the memory domain and
 * the Convex functions so the two can never disagree.
 *
 * None of them asks who or what typed a change. A change lands on evidence:
 * its tests passed on the exact tree that lands, and no reviewer, a model or
 * a person, left a high-severity finding open. Whoever presses Land is
 * responsible for it. An approval from someone other than the author is
 * shown, and a repository can make it required.
 */
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

/** The approvals that count on a change: from anyone but its author. */
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

/** The `reviewed` requirement, from the approvals and objections that hold. */
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

/**
 * Whether any of a repository's own rules depends on which files a change
 * touches, or how many lines. Auto-land refuses those repositories: the file
 * lists those rules read are not taken from git yet, so a person decides.
 */
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

/**
 * `allowed_paths`: a change may touch only these paths, whoever made it and
 * however it arrived, `git push` included. Token path limits cover the API;
 * this covers landing.
 */
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
