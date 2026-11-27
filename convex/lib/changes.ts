import { v } from 'convex/values'
import { seesChange } from './accessRules'
import {
  changeActions,
  checksSummary,
  evaluatePolicy,
  evaluateRules,
  headOf,
  latestReviews,
  policyState,
  presentActor,
  presentChange,
  presentCheck,
  presentEvidence,
  presentFinding,
  presentPatchSet,
  presentReview,
  presentReviewComment,
  ruleMode,
  unmetCount,
} from '@cobaltforge/api/change-view'
import type { PolicyConfig } from '@cobaltforge/api/change-view'
import { DEFAULT_LANDING } from '@cobaltforge/api/policy-file'
import type { FileError, Landing } from '@cobaltforge/api/policy-file'
import { fail } from './errors'
import { canWrite } from './access'
import { counters } from './events'
import { presentRepo, repoRef, repoUrl, urls } from './present'
import type { Actor } from './actor'
import type {
  ActorRec,
  Assume,
  ChangeRec,
  CheckRec,
  CustomRuleRec,
  EvidenceRec,
  FindingRec,
  GuideRec,
  PatchSetRec,
  PolicyExceptionRec,
  Requirement,
  ReviewCommentRec,
  ReviewRec,
  RuleMode,
} from './changeTypes'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export type RepoPolicy = {
  ruleModes: Map<string, RuleMode>
  customRules: Array<CustomRuleRec>
  exceptions: Array<PolicyExceptionRec>
  landing: Landing
  file: { text: string; sha: string; errors: Array<FileError> } | null
  rev: number
  doc: Doc<'repoPolicy'> | null
}

export async function loadPolicy(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
): Promise<RepoPolicy> {
  const doc = await ctx.db
    .query('repoPolicy')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
  const c = await counters(ctx, repo)
  return {
    ruleModes: new Map(
      (doc?.ruleModes ?? []).map((m) => [m.id, m.mode as RuleMode]),
    ),
    customRules: doc
      ? (JSON.parse(doc.customRules) as Array<CustomRuleRec>)
      : [],
    exceptions: doc
      ? (JSON.parse(doc.exceptions) as Array<PolicyExceptionRec>)
      : [],
    landing: doc?.landing
      ? ({ ...DEFAULT_LANDING, ...JSON.parse(doc.landing) } as Landing)
      : DEFAULT_LANDING,
    file:
      doc?.sourceText !== undefined
        ? {
            text: doc.sourceText,
            sha: doc.sourceSha ?? '',
            errors: JSON.parse(doc.errors ?? '[]') as Array<FileError>,
          }
        : null,
    rev: c.policyRev,
    doc,
  }
}

export async function savePolicy(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  p: RepoPolicy,
) {
  const fields = {
    ruleModes: [...p.ruleModes].map(([id, mode]) => ({ id, mode })),
    customRules: JSON.stringify(p.customRules),
    exceptions: JSON.stringify(p.exceptions),
    landing: JSON.stringify(p.landing),
    ...(p.file
      ? {
          sourceText: p.file.text,
          sourceSha: p.file.sha,
          errors: JSON.stringify(p.file.errors),
        }
      : {}),
  }
  if (p.doc) await ctx.db.patch('repoPolicy', p.doc._id, fields)
  else await ctx.db.insert('repoPolicy', { repoId: repo._id, ...fields })
  const c = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', c._id, { policyRev: c.policyRev + 1 })
}

type PartKind = Doc<'changeParts'>['kind']
const KINDS: Array<PartKind> = [
  'patchSet',
  'review',
  'finding',
  'check',
  'comment',
  'evidence',
  'guide',
]

export type Loaded = {
  doc: Doc<'changes'>
  rec: ChangeRec
  parts: Map<string, Doc<'changeParts'>>
}

const partKey = (kind: PartKind, key: string) => `${kind}:${key}`

export async function hydrate(
  ctx: QueryCtx,
  doc: Doc<'changes'>,
): Promise<Loaded> {
  const parts = new Map<string, Doc<'changeParts'>>()
  const lists: Record<PartKind, Array<unknown>> = {
    patchSet: [],
    review: [],
    finding: [],
    check: [],
    comment: [],
    evidence: [],
    guide: [],
  }
  for (const kind of KINDS)
    for (const p of await ctx.db
      .query('changeParts')
      .withIndex('by_changeId_and_kind_and_seq', (q) =>
        q.eq('changeId', doc._id).eq('kind', kind),
      )
      .take(5000)) {
      parts.set(partKey(kind, p.key), p)
      lists[kind].push(JSON.parse(p.json))
    }
  const rec: ChangeRec = {
    id: doc.publicId,
    number: doc.number,
    title: doc.title,
    description: doc.description,
    state: doc.state,
    author: doc.author,
    base: doc.base,
    branch: doc.branch,
    patchSets: lists.patchSet as Array<PatchSetRec>,
    reviews: lists.review as Array<ReviewRec>,
    findings: lists.finding as Array<FindingRec>,
    checks: lists.check as Array<CheckRec>,
    stackId: doc.stackId,
    labels: doc.labels,
    mirrors: doc.mirrors,
    evidence: lists.evidence as Array<EvidenceRec>,
    comments: lists.comment as Array<ReviewCommentRec>,
    ...(lists.guide.length ? { guide: lists.guide[0] as GuideRec } : {}),
    commentRev: doc.commentRev,
    ...(doc.baseFiles ? { baseFiles: JSON.parse(doc.baseFiles) } : {}),
    created: doc.created,
    updated: doc.updated,
    landed: doc.landed,
    ...(doc.abandonedFrom ? { abandonedFrom: doc.abandonedFrom } : {}),
    version: doc.version,
  }
  return { doc, rec, parts }
}

export async function loadChange(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  ref: string,
  viewer: Actor | null | 'internal',
): Promise<Loaded> {
  const doc = await findChange(ctx, repo, ref)
  if (!doc) fail('not_found', `No change ${ref} in ${repo.owner}/${repo.name}.`)
  const l = await hydrate(ctx, doc)
  if (viewer !== 'internal' && !(await seesChange(ctx, repo, l.rec, viewer)))
    fail('not_found', `No change ${ref} in ${repo.owner}/${repo.name}.`)
  return l
}

export async function findChange(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  ref: string,
) {
  if (/^\d+$/.test(ref))
    return await ctx.db
      .query('changes')
      .withIndex('by_repoId_and_number', (q) =>
        q.eq('repoId', repo._id).eq('number', Number(ref)),
      )
      .unique()
  if (ref.startsWith('chg_')) {
    const c = await ctx.db
      .query('changes')
      .withIndex('by_publicId', (q) => q.eq('publicId', ref))
      .unique()
    return c && c.repoId === repo._id ? c : null
  }
  return null
}

function partsOf(
  rec: ChangeRec,
): Array<{ kind: PartKind; key: string; value: unknown }> {
  return [
    ...rec.patchSets.map((x) => ({
      kind: 'patchSet' as const,
      key: String(x.n),
      value: x,
    })),
    ...rec.reviews.map((x) => ({
      kind: 'review' as const,
      key: x.id,
      value: x,
    })),
    ...rec.findings.map((x) => ({
      kind: 'finding' as const,
      key: x.id,
      value: x,
    })),
    ...rec.checks.map((x) => ({ kind: 'check' as const, key: x.id, value: x })),
    ...(rec.comments ?? []).map((x) => ({
      kind: 'comment' as const,
      key: x.id,
      value: x,
    })),
    ...(rec.evidence ?? []).map((x) => ({
      kind: 'evidence' as const,
      key: x.id,
      value: x,
    })),
    ...(rec.guide
      ? [{ kind: 'guide' as const, key: 'current', value: rec.guide }]
      : []),
  ]
}

function changeFields(rec: ChangeRec) {
  return {
    publicId: rec.id,
    number: rec.number,
    title: rec.title,
    description: rec.description,
    text: `${rec.title}\n${rec.description}`,
    state: rec.state,
    author: rec.author,
    base: rec.base,
    branch: rec.branch,
    stackId: rec.stackId,
    labels: rec.labels,
    mirrors: rec.mirrors,
    ...(rec.baseFiles ? { baseFiles: JSON.stringify(rec.baseFiles) } : {}),
    commentRev: rec.commentRev ?? 0,
    headSha: rec.patchSets[rec.patchSets.length - 1]?.sha ?? '',
    created: rec.created,
    updated: rec.updated,
    landed: rec.landed,
    abandonedFrom: rec.state === 'abandoned' ? rec.abandonedFrom : undefined,
    version: rec.version,
  }
}

export async function saveChange(ctx: MutationCtx, l: Loaded) {
  await ctx.db.patch('changes', l.doc._id, changeFields(l.rec))
  await saveParts(ctx, l.doc._id, l.rec, l.parts)
}

async function saveParts(
  ctx: MutationCtx,
  changeId: Id<'changes'>,
  rec: ChangeRec,
  parts: Map<string, Doc<'changeParts'>>,
) {
  const seen = new Set<string>()
  const seqs = new Map<PartKind, number>()
  for (const p of parts.values())
    seqs.set(p.kind, Math.max(seqs.get(p.kind) ?? 0, p.seq))
  for (const { kind, key, value } of partsOf(rec)) {
    const k = partKey(kind, key)
    seen.add(k)
    const json = JSON.stringify(value)
    const had = parts.get(k)
    if (had) {
      if (had.json !== json)
        await ctx.db.patch('changeParts', had._id, { json })
      continue
    }
    const seq = kind === 'patchSet' ? Number(key) : (seqs.get(kind) ?? 0) + 1
    seqs.set(kind, Math.max(seqs.get(kind) ?? 0, seq))
    await ctx.db.insert('changeParts', { changeId, kind, key, seq, json })
  }
  for (const [k, p] of parts)
    if (!seen.has(k)) await ctx.db.delete('changeParts', p._id)
}

export async function insertChange(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  rec: ChangeRec,
) {
  const id = await ctx.db.insert('changes', {
    repoId: repo._id,
    ...changeFields(rec),
  })
  await saveParts(ctx, id, rec, new Map())
  return id
}

export async function branchOwner(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  branch: string,
): Promise<Doc<'changes'> | null> {
  const all = await ctx.db
    .query('changes')
    .withIndex('by_repoId_and_branch', (q) =>
      q.eq('repoId', repo._id).eq('branch', branch),
    )
    .take(500)
  return (
    all
      .filter((c) => c.state === 'open' || c.state === 'draft')
      .sort((a, b) => a.number - b.number)
      .at(0) ?? null
  )
}

export async function stackMembers(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  stackId: string,
) {
  const all = await ctx.db
    .query('changes')
    .withIndex('by_repoId_and_stackId', (q) =>
      q.eq('repoId', repo._id).eq('stackId', stackId),
    )
    .take(500)
  return all.sort((a, b) => a.number - b.number)
}

export class ChangeView {
  constructor(
    readonly repo: Doc<'repos'>,
    readonly policy: RepoPolicy,
    readonly now: number,
    readonly stack: Map<number, Doc<'changes'>>,
    readonly stacks: Map<string, Array<number>>,
    readonly branchOwnerOf: (branch: string) => Doc<'changes'> | null,
    readonly viewerCanWrite: boolean,
    readonly repoShown: unknown,
  ) {}

  private cfg?: PolicyConfig

  private get config(): PolicyConfig {
    const maintainers = new Set(this.repo.maintainers)
    return (this.cfg ??= {
      modes: this.policy.ruleModes,
      exceptions: this.policy.exceptions,
      customRules: this.policy.customRules,
      landing: this.policy.landing,
      isMaintainer: (h) => maintainers.has(h),
      now: this.now,
    })
  }

  actor(a: ActorRec) {
    return presentActor(a)
  }

  head(c: ChangeRec) {
    return headOf(c)
  }

  checksFor(c: ChangeRec) {
    return checksSummary(c)
  }

  modeOf(id: string): RuleMode {
    return ruleMode(this.config, id)
  }

  evaluate(c: ChangeRec, assume: Assume = {}): Array<Requirement> {
    return evaluatePolicy(this.config, c, latestReviews(c.reviews), assume)
  }

  evaluateRules(c: ChangeRec, assume: Assume): Array<Requirement> {
    return evaluateRules(this.config, c, latestReviews(c.reviews), assume)
  }

  policyState(reqs: ReadonlyArray<Requirement>) {
    return policyState(reqs)
  }

  unmet(reqs: ReadonlyArray<Requirement>) {
    return unmetCount(reqs)
  }

  orderOf(stackId: string | null) {
    return stackId ? (this.stacks.get(stackId) ?? []) : []
  }

  parentOf(c: ChangeRec) {
    if (!c.stackId) return null
    const order = this.orderOf(c.stackId)
    const i = order.indexOf(c.number)
    return i > 0 ? (this.stack.get(order[i - 1]) ?? null) : null
  }

  actionsFor(c: ChangeRec, p: Actor | null) {
    return changeActions({
      change: c,
      viewer: p,
      canWrite: this.viewerCanWrite,
      reqs: p ? this.evaluate(c) : [],
      parent: this.parentOf(c),
      branchOwner: this.branchOwnerOf(c.branch),
    })
  }

  presentFinding(c: ChangeRec, f: FindingRec) {
    return presentFinding(repoUrl(this.repo), c, f)
  }

  presentCheck(k: CheckRec) {
    return presentCheck(k)
  }

  presentPatchSet(c: ChangeRec, ps: PatchSetRec) {
    return presentPatchSet(repoUrl(this.repo), c, ps)
  }

  presentReview(r: ReviewRec) {
    return presentReview(r)
  }

  presentReviewComment(c: ChangeRec, x: ReviewCommentRec) {
    return presentReviewComment(c, x)
  }

  presentEvidence(c: ChangeRec, e: EvidenceRec) {
    const u = e.upload ?? {
      id: e.uploadId,
      contentType: 'application/octet-stream',
      size: 0,
      sha256: '',
    }
    return presentEvidence(urls().api, c, e, u)
  }

  presentChange(
    c: ChangeRec,
    viewer: Actor | null | 'event',
    expand: ReadonlyArray<string> = [],
  ) {
    return presentChange({
      change: c,
      repoUrl: repoUrl(this.repo),
      htmlUrl: `${urls().html}/${this.repo.owner}/${this.repo.name}`,
      repo: expand.includes('repo') ? this.repoShown : repoRef(this.repo),
      reqs: this.evaluate(c),
      reviews: latestReviews(c.reviews),
      members: this.orderOf(c.stackId),
      parent: this.parentOf(c),
      actions: viewer === 'event' ? null : this.actionsFor(c, viewer),
      expand,
    })
  }
}

export async function viewFor(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  viewer: Actor | null,
  now: number,
  changes: Array<{ stackId: string | null; branch: string }>,
  opts: { expandRepo?: boolean; assume?: Assume } = {},
) {
  const policy = await loadPolicy(ctx, repo)
  const stack = new Map<number, Doc<'changes'>>()
  const stacks = new Map<string, Array<number>>()
  for (const s of new Set(
    changes.map((c) => c.stackId).filter((x): x is string => !!x),
  )) {
    const members = await stackMembers(ctx, repo, s)
    for (const m of members) stack.set(m.number, m)
    stacks.set(
      s,
      members.map((m) => m.number),
    )
  }
  const owners = new Map<string, Doc<'changes'> | null>()
  for (const b of new Set(changes.map((c) => c.branch)))
    owners.set(b, await branchOwner(ctx, repo, b))
  return new ChangeView(
    repo,
    policy,
    now,
    stack,
    stacks,
    (b) => owners.get(b) ?? null,
    viewer ? await canWrite(ctx, repo, viewer) : false,
    opts.expandRepo ? await presentRepo(ctx, repo, now) : null,
  )
}

/** The files a patch set touches, as the API reads them from git. */
export const fileStatsValidator = v.array(
  v.object({ path: v.string(), add: v.number(), del: v.number() }),
)

export function filesOfStats(
  stats: ReadonlyArray<{ path: string; add: number; del: number }>,
  sha: string,
): PatchSetRec['files'] {
  return Object.fromEntries(
    stats.map((f) => [
      f.path,
      { hash: sha.slice(0, 6), add: f.add, del: f.del },
    ]),
  )
}
