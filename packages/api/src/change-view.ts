import type { z } from 'zod'
import type * as S from './schemas'
import { globMatcher } from './glob'
import {
  allowedPathsRequirement,
  approvalsOf,
  policyRules,
  reviewedRequirement,
} from './policy-builtins'
import { DEFAULT_LANDING, policyFileCheck } from './policy-file'
import type { Landing } from './policy-file'
import { currentPosition, presentAnchor } from './anchors'
import { iso } from './domain/records'
import type {
  ActorRec,
  Assume,
  CheckRec,
  CustomRuleRec,
  FindingRec,
  PatchSetRec,
  PolicyExceptionRec,
  ReviewCommentRec,
  ReviewRec,
  RuleMode,
} from './domain/records'

export type Requirement = z.infer<typeof S.Requirement>
export type PolicyState = 'met' | 'blocked' | 'pending'

type Change = {
  id: string
  number: number
  title: string
  description: string
  state: 'draft' | 'open' | 'landed' | 'abandoned'
  author: ActorRec
  base: string
  branch: string
  patchSets: Array<PatchSetRec>
  reviews: Array<ReviewRec>
  findings: Array<FindingRec>
  checks: Array<CheckRec>
  stackId: string | null
  labels: Array<string>
  mirrors: Array<{ host: string; number: number; origin: 'here' | 'there' }>
  evidence?: ReadonlyArray<unknown>
  comments?: Array<ReviewCommentRec>
  created: number
  updated: number
  landed: number | null
  version: number
}

export const presentActor = (a: ActorRec) => ({
  object: 'actor' as const,
  id: a.id,
  handle: a.handle,
})

export const headOf = (c: Pick<Change, 'patchSets'>) =>
  c.patchSets[c.patchSets.length - 1]

export function latestReviews(reviews: ReadonlyArray<ReviewRec>) {
  const map = new Map<string, ReviewRec>()
  for (const r of reviews) map.set(r.actor.id, r)
  return [...map.values()]
}

export function checksSummary(c: Change): z.infer<typeof S.Change>['checks'] {
  const tree = headOf(c).tree
  const own = c.checks.filter((k) => k.tree === tree)
  const passed = own.filter((k) => k.state === 'pass').length
  const failed = own.filter((k) => k.state === 'fail').length
  const pending = own.filter((k) => k.state === 'pending').length
  return {
    state:
      own.length === 0
        ? 'none'
        : failed
          ? 'fail'
          : pending
            ? 'pending'
            : 'pass',
    passed,
    failed,
    pending,
  }
}

export type PolicyConfig = {
  modes?: ReadonlyMap<string, RuleMode>
  exceptions?: ReadonlyArray<PolicyExceptionRec>
  customRules?: ReadonlyArray<CustomRuleRec>
  landing?: Landing
  isMaintainer: (handle: string) => boolean
  now: number
}

export const ruleMode = (cfg: PolicyConfig, id: string): RuleMode =>
  cfg.modes?.get(id) ?? policyRules.find((r) => r.id === id)?.mode ?? 'enforce'

const exceptionFor = (cfg: PolicyConfig, rule: string, who: string) =>
  cfg.exceptions?.find(
    (e) => e.rule === rule && e.who === who && e.expires > cfg.now,
  )

export function evaluatePolicy(
  cfg: PolicyConfig,
  c: Change,
  reviews: ReadonlyArray<ReviewRec>,
  assume: Assume = {},
): Array<Requirement> {
  const out: Array<Requirement> = []
  for (const r of evaluateRules(cfg, c, reviews, assume)) {
    const mode = ruleMode(cfg, r.id)
    if (mode === 'off') continue
    if (mode === 'dry-run' && (r.state === 'fail' || r.state === 'pending'))
      out.push({
        ...r,
        state: 'na',
        detail: `Dry run, would block: ${r.detail}`,
        needs: null,
        blocking: [],
      })
    else out.push(r)
  }
  return out
}

export function evaluateRules(
  cfg: PolicyConfig,
  c: Change,
  latest: ReadonlyArray<ReviewRec>,
  assume: Assume,
): Array<Requirement> {
  const head = headOf(c)
  const out: Array<Requirement> = []
  const fresh = (cfg.landing ?? DEFAULT_LANDING).fresh_approvals
  const reviews = latest.map((r) =>
    fresh && r.patchSet !== head.n ? { ...r, carries: false } : r,
  )
  const approvals = approvalsOf(reviews, c.author.handle, assume.approve)
  const objections = reviews.filter(
    (r) => r.state === 'changes' && r.actor.handle !== c.author.handle,
  )
  const run = latestRun(
    c,
    head,
    (k) => k.key === 'ci/test' || k.name === 'ci/test',
  )
  const remote = run ? null : providerChecks(c, head)
  const ciState =
    assume.checks?.['ci/test'] ?? run?.state ?? remote?.state ?? 'pending'
  out.push({
    id: 'ci-evidence',
    rule: 'Tests pass on the tree that will land',
    state: ciState,
    detail: remote
      ? ciState === 'pass'
        ? `${remote.runs.length} checks on ${remote.host} passed on tree ${head.tree}, the tree that lands.`
        : ciState === 'fail'
          ? `${remote.failed.map((k) => k.name).join(', ')} failed on ${remote.host}, tree ${head.tree}.`
          : `Checks on ${remote.host} are running on tree ${head.tree}.`
      : ciState === 'pass'
        ? `ci/test passed on tree ${head.tree}, the tree that lands.`
        : ciState === 'fail'
          ? `ci/test failed on tree ${head.tree}.`
          : run
            ? `ci/test is running on tree ${head.tree}.`
            : `No ci/test result for tree ${head.tree} yet.`,
    needs: { check: 'ci/test', bound_to: 'tree', tree: head.tree },
    blocking:
      ciState === 'fail'
        ? run
          ? [run.id]
          : (remote?.failed.map((k) => k.id) ?? [])
        : [],
  })
  const open = c.findings.filter(
    (f) =>
      f.severity === 'high' &&
      f.state === 'open' &&
      !(assume.resolve ?? []).includes(f.label),
  )
  out.push({
    id: 'findings',
    rule: 'No open high-severity findings',
    state: open.length ? 'fail' : 'pass',
    detail: open.length
      ? `${open.length} open: ${open.map((f) => `${f.label} from ${f.by}`).join(', ')}.`
      : 'No open high-severity findings.',
    needs: open.length ? { resolve: open.map((f) => f.label) } : null,
    blocking: open.map((f) => f.id),
  })
  out.push(reviewedRequirement(approvals, objections))
  const lines = Object.values(head.files).reduce((n, f) => n + f.add + f.del, 0)
  for (const r of cfg.customRules ?? [])
    out.push(customRequirement(r, c, assume, approvals, lines))
  const policy = policyFileCheck(head, policyRules, cfg.isMaintainer, [
    ...approvals,
  ])
  if (policy) out.push(policy)
  return out.map((r) => {
    if (r.state === 'pass' || r.state === 'na') return r
    const e = exceptionFor(cfg, r.id, c.author.handle)
    return e
      ? {
          ...r,
          state: 'pass' as const,
          detail: `Exception for ${e.who} until ${new Date(e.expires).toISOString().slice(0, 10)}: ${e.reason}`,
          needs: null,
          blocking: [],
        }
      : r
  })
}

const PROVIDER_HOSTS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  forgejo: 'Forgejo',
}

/**
 * A change imported from another host carries that host's checks
 * (`github:CI`), not a `ci/test` of ours. They count as the tests of the tree
 * when they ran on it: all must pass, and any one failing fails.
 */
function providerChecks(c: Change, head: PatchSetRec) {
  const latest = new Map<string, CheckRec>()
  for (const k of c.checks) {
    const host = k.key.split(':')[0]
    if (k.tree !== head.tree || !(host in PROVIDER_HOSTS)) continue
    const had = latest.get(k.key)
    if (!had || had.updated < k.updated) latest.set(k.key, k)
  }
  const runs = [...latest.values()]
  if (runs.length === 0) return null
  const failed = runs.filter((k) => k.state === 'fail')
  return {
    host: PROVIDER_HOSTS[runs[0].key.split(':')[0]],
    runs,
    failed,
    state: failed.length
      ? ('fail' as const)
      : runs.some((k) => k.state === 'pending')
        ? ('pending' as const)
        : ('pass' as const),
  }
}

const latestRun = (
  c: Change,
  head: PatchSetRec,
  is: (k: CheckRec) => boolean,
): CheckRec | undefined =>
  c.checks
    .filter((k) => is(k) && k.tree === head.tree)
    .sort((a, b) => b.updated - a.updated)[0]

function customRequirement(
  r: CustomRuleRec,
  c: Change,
  assume: Assume,
  approvals: Set<string>,
  lines: number,
): Requirement {
  const head = headOf(c)
  const base = { id: r.id, rule: r.name }
  if (r.kind === 'required_check') {
    const key = r.check!
    const run = latestRun(c, head, (k) => k.key === key || k.name === key)
    const state = assume.checks?.[key] ?? run?.state ?? 'pending'
    return {
      ...base,
      state,
      detail:
        state === 'pass'
          ? `${key} passed on tree ${head.tree}.`
          : state === 'fail'
            ? `${key} failed on tree ${head.tree}.`
            : `No ${key} result for tree ${head.tree} yet.`,
      needs: { check: key, bound_to: 'tree', tree: head.tree },
      blocking: state === 'fail' && run ? [run.id] : [],
    }
  }
  if (r.kind === 'max_lines') {
    const over = lines > r.maxLines!
    return {
      ...base,
      state: over ? 'fail' : 'pass',
      detail: over
        ? `${lines} lines changed, over the ${r.maxLines} this repository allows. Split it into a stack.`
        : `${lines} lines changed, within ${r.maxLines}.`,
      needs: over ? { max_lines: r.maxLines } : null,
      blocking: [],
    }
  }
  if (r.kind === 'allowed_paths') return allowedPathsRequirement(r, head)
  const globs = (r.paths ?? []).map((g) => globMatcher(g))
  const touched = Object.keys(head.files).filter((f) =>
    globs.some((g) => g.test(f)),
  )
  if (!touched.length)
    return {
      ...base,
      state: 'na',
      detail: `Touches nothing in ${(r.paths ?? []).join(', ')}.`,
      needs: null,
      blocking: [],
    }
  const need = r.approvals ?? 1
  const from = r.from?.length ? new Set(r.from) : null
  const got = [...approvals].filter((h) => !from || from.has(h))
  return {
    ...base,
    state: got.length >= need ? 'pass' : 'pending',
    detail:
      got.length >= need
        ? `${got.join(', ')} approved ${touched.length} file${touched.length === 1 ? '' : 's'} in ${(r.paths ?? []).join(', ')}.`
        : `${touched[0]}${touched.length > 1 ? ` and ${touched.length - 1} more` : ''} need ${need} approval${need === 1 ? '' : 's'}${from ? ` from ${[...from].join(', ')}` : ''}, ${got.length} so far.`,
    needs: {
      approval: {
        min: need,
        ...(from ? { from: [...from] } : {}),
      },
      paths: touched,
    },
    blocking: [],
  }
}

export function policyState(reqs: ReadonlyArray<Requirement>): PolicyState {
  if (reqs.some((r) => r.state === 'fail')) return 'blocked'
  if (reqs.some((r) => r.state === 'pending')) return 'pending'
  return 'met'
}

export const unmetCount = (reqs: ReadonlyArray<Requirement>) =>
  reqs.filter((r) => r.state === 'fail' || r.state === 'pending').length

export function changeActions(a: {
  change: Change
  viewer: { scopes: ReadonlySet<string> } | null
  canWrite: boolean
  reqs: ReadonlyArray<Requirement>
  parent: { number: number; state: string } | null
  branchOwner: { number: number } | null | undefined
}): NonNullable<z.infer<typeof S.Change>['actions']> {
  const { change: c, viewer: p } = a
  const no = (why: string) => ({ allowed: false, reasons: [why] })
  if (!p) {
    const s = no('sign_in')
    return { land: s, abandon: s, restore: s, mark_ready: s }
  }
  const canPull = a.canWrite && p.scopes.has('pulls:write')
  const canMerge = a.canWrite && p.scopes.has('pulls:merge')
  const reasons: Array<string> = []
  if (c.state !== 'open') reasons.push(`state:${c.state}`)
  if (!canMerge) reasons.push('scope:pulls:merge')
  for (const r of a.reqs)
    if (r.state === 'fail' || r.state === 'pending')
      reasons.push(`policy:${r.id} ${r.state === 'fail' ? 'fail' : 'pending'}`)
  if (a.parent && a.parent.state !== 'landed')
    reasons.push(`parent:#${a.parent.number} not landed`)
  const pullOr = (ok: boolean) =>
    canPull && ok
      ? { allowed: true, reasons: [] }
      : no(canPull ? `state:${c.state}` : 'scope:pulls:write')
  return {
    land: { allowed: reasons.length === 0, reasons },
    abandon: pullOr(c.state === 'open' || c.state === 'draft'),
    restore:
      canPull && c.state === 'abandoned' && a.branchOwner
        ? { allowed: false, reasons: [`branch:#${a.branchOwner.number}`] }
        : pullOr(c.state === 'abandoned'),
    mark_ready: pullOr(c.state === 'draft'),
  }
}

export function presentChange(a: {
  change: Change
  repoUrl: string
  htmlUrl: string
  repo: unknown
  reqs: ReadonlyArray<Requirement>
  reviews: ReadonlyArray<ReviewRec>
  members: ReadonlyArray<number>
  parent: { number: number } | null
  actions: z.infer<typeof S.Change>['actions']
  expand: ReadonlyArray<string>
}) {
  const { change: c, expand } = a
  const head = headOf(c)
  let additions = 0
  let deletions = 0
  for (const f of Object.values(head.files)) {
    additions += f.add
    deletions += f.del
  }
  return {
    object: 'change' as const,
    id: c.id,
    number: c.number,
    url: `${a.repoUrl}/changes/${c.number}`,
    html_url: `${a.htmlUrl}/changes/${c.number}`,
    repo: a.repo,
    title: c.title,
    description: c.description,
    state: c.state,
    author: presentActor(c.author),
    base: c.base,
    branch: c.branch,
    patch_set_count: c.patchSets.length,
    head: {
      patch_set: head.n,
      sha: head.sha,
      tree: head.tree,
      via: head.via ?? null,
    },
    stack: c.stackId
      ? {
          id: c.stackId,
          position: a.members.indexOf(c.number) + 1,
          size: a.members.length,
          parent: a.parent?.number ?? null,
        }
      : null,
    stats: { files: Object.keys(head.files).length, additions, deletions },
    checks: checksSummary(c),
    policy: { state: policyState(a.reqs), blocking: unmetCount(a.reqs) },
    reviewers: a.reviews.map((r) => ({
      actor: presentActor(r.actor),
      state: r.state,
      patch_set: r.patchSet,
      carries_to_head: r.carries,
    })),
    mirrors: c.mirrors,
    labels: c.labels,
    evidence_count: c.evidence?.length ?? 0,
    findings: expand.includes('findings')
      ? c.findings.map((f) => presentFinding(a.repoUrl, c, f))
      : null,
    check_runs: expand.includes('check_runs')
      ? c.checks.map((k) => presentCheck(k))
      : null,
    actions: a.actions,
    landed_at: c.landed ? iso(c.landed) : null,
    created_at: iso(c.created),
    updated_at: iso(c.updated),
    version: c.version,
  }
}

export function presentFinding(
  repoUrl: string,
  c: { number: number },
  f: FindingRec,
): z.infer<typeof S.Finding> {
  return {
    object: 'finding',
    id: f.id,
    label: f.label,
    by: f.by,
    severity: f.severity,
    state: f.state,
    reason: f.reason,
    file: f.file,
    line: f.line,
    title: f.title,
    body: f.body,
    patch_set: f.patchSet,
    url: `${repoUrl}/changes/${c.number}/findings/${f.id}`,
    suggestion: f.suggestion ?? null,
    prompt: f.prompt ?? null,
    via: f.via ?? null,
    created_at: iso(f.created),
  }
}

export function presentCheck(k: CheckRec): z.infer<typeof S.CheckRun> {
  return {
    object: 'check_run',
    id: k.id,
    key: k.key,
    name: k.name,
    state: k.state,
    tree: k.tree,
    details_url: k.detailsUrl,
    cases: k.cases ?? null,
    created_at: iso(k.created),
    updated_at: iso(k.updated),
  }
}

export function presentPatchSet(
  repoUrl: string,
  c: { number: number },
  ps: PatchSetRec,
): z.infer<typeof S.PatchSet> {
  return {
    object: 'patch_set',
    number: ps.n,
    change: c.number,
    sha: ps.sha,
    tree: ps.tree,
    note: ps.note,
    author: presentActor(ps.author),
    files: Object.keys(ps.files).length,
    url: `${repoUrl}/changes/${c.number}/patch-sets/${ps.n}`,
    via: ps.via ?? null,
    created_at: iso(ps.created),
  }
}

export function presentReview(r: ReviewRec): z.infer<typeof S.Review> {
  return {
    object: 'review',
    id: r.id,
    actor: presentActor(r.actor),
    state: r.state,
    patch_set: r.patchSet,
    carries_to_head: r.carries,
    body: r.body,
    via: r.via ?? null,
    created_at: iso(r.created),
  }
}

export function presentReviewComment(
  c: Pick<Change, 'number' | 'patchSets' | 'comments'>,
  x: ReviewCommentRec,
) {
  const root = x.replyTo
    ? (c.comments ?? []).find((y) => y.id === x.replyTo)
    : undefined
  const start = root ?? x
  return {
    object: 'change_comment' as const,
    id: x.id,
    change: c.number,
    author: presentActor(x.author),
    body: x.body,
    file: x.file,
    line: x.line,
    patch_set: x.patchSet,
    reply_to: x.replyTo,
    resolved: x.resolved,
    anchor: start.anchor ? presentAnchor(start.anchor) : null,
    ...currentPosition(x, root, headOf(c).n),
    addressed: x.addressed
      ? {
          patch_set: x.addressed.patchSet,
          by: presentActor(x.addressed.by),
          note: x.addressed.note,
          at: iso(x.addressed.at),
        }
      : null,
    via: x.via ?? null,
    created_at: iso(x.created),
    updated_at: iso(x.updated),
    version: x.version,
  }
}

export function presentEvidence(
  apiUrl: string,
  c: { number: number },
  e: {
    id: string
    kind: 'image' | 'recording' | 'preview' | 'test_results'
    caption: string
    by: ActorRec
    created: number
  },
  u: { id: string; contentType: string; size: number; sha256?: string | null },
): z.infer<typeof S.Evidence> {
  return {
    object: 'evidence',
    id: e.id,
    change: c.number,
    kind: e.kind,
    caption: e.caption,
    upload: {
      id: u.id,
      content_type: u.contentType,
      size: u.size,
      sha256: u.sha256 ?? '',
      content_url: `${apiUrl}/uploads/${u.id}/content`,
    },
    created_by: presentActor(e.by),
    created_at: iso(e.created),
  }
}
