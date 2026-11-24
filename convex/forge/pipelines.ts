import {
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  canMove,
  cancelPipeline,
  expireWait,
  jobWait,
  pipelineLifecycle,
  reportStep,
  requeueJob,
  resumeStep,
  settlePipeline,
  waitStep,
} from '@cobaltforge/api/lifecycles'
import type { PipelineStatus, PipelineWait } from '@cobaltforge/api/lifecycles'
import { LEASE_MS, waitingForLabels } from '@cobaltforge/api/runners'
import type { RunnerLike } from '@cobaltforge/api/runners'
import { v } from 'convex/values'
import { newId } from '@cobaltforge/api/ids'
import { applyRunsOn } from '@cobaltforge/api/runs-on'
import { internal } from '../_generated/api'
import { internalMutation, query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { actorOf, signedIn, system } from '../lib/actor'
import { accessStamp, repoByPublicId, resolve } from '../lib/access'
import { fail, finish, out } from '../lib/errors'
import { counters } from '../lib/events'
import { repoUrl, urls } from '../lib/present'
import { notify } from './notifications'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

type Status = PipelineStatus
type Line = { t: string; level: string | null }
type Step = {
  name: string
  status: string
  duration: number
  lines: Array<Line>
  wait?: PipelineWait | null
}
type Job = {
  name: string
  runner: string
  status: string
  duration: number
  runsOn?: Array<string>
  runnerId?: string | null
  lease?: number | null
  steps: Array<Step>
}
export type PipelineRun = {
  id: string
  number: number
  workflow: string
  title: string
  branch: string
  sha: string
  status: Status
  trigger: string
  runsOnPending?: boolean
  runsOnFrom?: number
  actor: string
  started: number
  finished: number | null
  file: string
  annotations: Array<{
    level: 'error' | 'warn'
    text: string
    job: string
    step: string
  }>
  jobs: Array<Job>
  version: number
}

const iso = (t: number) => new Date(t).toISOString()

export async function load(
  ctx: QueryCtx,
  doc: Doc<'pipelineRuns'>,
  withLines = false,
): Promise<PipelineRun> {
  const r = JSON.parse(doc.json) as PipelineRun
  for (const j of r.jobs)
    for (const s of j.steps) (s as { lines?: Array<Line> }).lines ??= []
  if (withLines)
    for (const log of await ctx.db
      .query('pipelineLogs')
      .withIndex('by_runId_and_job_and_step', (q) => q.eq('runId', doc._id))
      .take(1000)) {
      const s = r.jobs.at(log.job - 1)?.steps.at(log.step - 1)
      if (s) s.lines = JSON.parse(log.lines) as Array<Line>
    }
  return r
}

async function lineCounts(ctx: QueryCtx, doc: Doc<'pipelineRuns'>) {
  const counts = new Map<string, number>()
  for (const log of await ctx.db
    .query('pipelineLogs')
    .withIndex('by_runId_and_job_and_step', (q) => q.eq('runId', doc._id))
    .take(1000))
    counts.set(`${log.job}/${log.step}`, log.count)
  return counts
}

function stripped(r: PipelineRun) {
  return JSON.stringify({
    ...r,
    jobs: r.jobs.map((j) => ({
      ...j,
      steps: j.steps.map((s) => ({ ...s, lines: [] })),
    })),
  })
}

export async function insertRun(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  r: PipelineRun,
) {
  const id = await ctx.db.insert('pipelineRuns', {
    repoId: repo._id,
    publicId: r.id,
    number: r.number,
    workflow: r.workflow,
    status: r.status,
    started: r.started,
    json: stripped(r),
  })
  for (const [ji, j] of r.jobs.entries())
    for (const [si, s] of j.steps.entries())
      if (s.lines.length) await writeLog(ctx, id, ji + 1, si + 1, s.lines)
  const c = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', c._id, {
    pipelines: (c.pipelines ?? 0) + 1,
    pipelineNumber: Math.max(c.pipelineNumber ?? 0, r.number),
    pipelineRev: (c.pipelineRev ?? 0) + 1,
  })
  return id
}

async function writeLog(
  ctx: MutationCtx,
  runId: Id<'pipelineRuns'>,
  job: number,
  step: number,
  lines: Array<Line>,
) {
  const kept = lines.slice(-5000)
  const had = await ctx.db
    .query('pipelineLogs')
    .withIndex('by_runId_and_job_and_step', (q) =>
      q.eq('runId', runId).eq('job', job).eq('step', step),
    )
    .unique()
  if (had)
    await ctx.db.patch('pipelineLogs', had._id, {
      lines: JSON.stringify(kept),
      count: kept.length,
    })
  else
    await ctx.db.insert('pipelineLogs', {
      runId,
      job,
      step,
      lines: JSON.stringify(kept),
      count: kept.length,
    })
}

export async function save(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  doc: Doc<'pipelineRuns'>,
  r: PipelineRun,
) {
  await ctx.db.patch('pipelineRuns', doc._id, {
    status: r.status,
    json: stripped(r),
  })
  const c = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', c._id, {
    pipelineRev: (c.pipelineRev ?? 0) + 1,
  })
}

export async function runnersOf(
  ctx: QueryCtx,
  account: string,
): Promise<Array<RunnerLike & { doc: Doc<'runners'> }>> {
  const docs = await ctx.db
    .query('runners')
    .withIndex('by_account_and_name', (q) => q.eq('account', account))
    .take(200)
  const found: Array<RunnerLike & { doc: Doc<'runners'> }> = []
  for (const d of docs) {
    let repos: Array<string> | null = null
    if (d.repos) {
      repos = []
      for (const id of d.repos) {
        const r = await repoByPublicId(ctx, id)
        if (r && r.owner === d.account)
          repos.push(`${r.owner}/${r.name}`.toLowerCase())
      }
    }
    found.push({
      account: d.account,
      labels: d.labels,
      repos,
      concurrency: d.concurrency,
      disabled: d.status === 'disabled',
      lastSeen: null,
      doc: d,
    })
  }
  return found
}

const presentWait = (w: PipelineWait | null | undefined) =>
  w
    ? {
        kind: w.kind,
        reason: w.reason,
        target: w.target,
        expires_at: iso(w.expires),
      }
    : null

export function present(
  repo: Doc<'repos'>,
  r: PipelineRun,
  detail: boolean,
  counts?: Map<string, number>,
  runners: Array<RunnerLike> = [],
) {
  const base = `${repoUrl(repo)}/pipelines/${r.number}`
  return {
    object: 'pipeline_run' as const,
    id: r.id,
    number: r.number,
    url: base,
    html_url: `${urls().html}/${repo.owner}/${repo.name}/pipelines?n=${r.number}`,
    workflow: r.workflow,
    file: r.file,
    title: r.title,
    branch: r.branch,
    sha: r.sha,
    status: r.status,
    trigger: r.trigger,
    actor: r.actor,
    started_at: iso(r.started),
    finished_at: r.finished === null ? null : iso(r.finished),
    duration_ms: r.finished === null ? null : r.finished - r.started,
    jobs: detail
      ? r.jobs.map((j, ji) => ({
          name: j.name,
          runner: j.runner,
          status: j.status,
          duration_ms: j.duration,
          runs_on: [...(j.runsOn ?? [])],
          runner_id: j.runnerId ?? null,
          lease_expires_at: j.lease ? iso(j.lease) : null,
          waiting_for_labels:
            j.status === 'queued'
              ? waitingForLabels(j.runsOn ?? [], runners, repo.owner, repo.name)
              : null,
          wait: presentWait(jobWait(j)),
          steps: j.steps.map((s, si) => ({
            name: s.name,
            status: s.status,
            duration_ms: s.duration,
            lines: counts?.get(`${ji + 1}/${si + 1}`) ?? s.lines.length,
            log_url: `${base}/jobs/${ji + 1}/steps/${si + 1}/log`,
            wait: presentWait(s.wait),
          })),
        }))
      : null,
    runs_on_pending: !!r.runsOnPending,
    annotations: r.annotations,
    version: r.version,
  }
}

export async function runOf(ctx: QueryCtx, repo: Doc<'repos'>, n: number) {
  const doc = await ctx.db
    .query('pipelineRuns')
    .withIndex('by_repoId_and_number', (q) =>
      q.eq('repoId', repo._id).eq('number', n),
    )
    .unique()
  if (!doc)
    fail('not_found', `No pipeline run ${n} in ${repo.owner}/${repo.name}.`)
  return doc
}

export const shown = async (
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  doc: Doc<'pipelineRuns'>,
  r: PipelineRun,
) =>
  present(
    repo,
    r,
    true,
    await lineCounts(ctx, doc),
    await runnersOf(ctx, repo.owner),
  )

export function claimedJob(repo: Doc<'repos'>, r: PipelineRun, ji: number) {
  const j = r.jobs[ji]
  return {
    object: 'pipeline_job' as const,
    run: r.number,
    job: ji + 1,
    name: j.name,
    workflow: r.workflow,
    file: r.file,
    branch: r.branch,
    sha: r.sha,
    steps: j.steps.map((s, si) => ({ number: si + 1, name: s.name })),
    url: `${repoUrl(repo)}/pipelines/${r.number}/jobs/${ji + 1}`,
    runs_on: [...(j.runsOn ?? [])],
    runner_id: j.runnerId ?? null,
    lease_expires_at: j.lease ? iso(j.lease) : null,
  }
}

const statusArg = v.optional(v.string())

export const list = query({
  args: {
    owner: v.string(),
    name: v.string(),
    status: statusArg,
    workflow: v.optional(v.string()),
    after: v.union(
      v.null(),
      v.object({ key: v.union(v.string(), v.number()), id: v.string() }),
    ),
    limit: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, q) => {
    const repo = await resolve(ctx, q.owner, q.name, await actorOf(ctx))
    const all = (
      await ctx.db
        .query('pipelineRuns')
        .withIndex('by_repoId_and_started', (x) => x.eq('repoId', repo._id))
        .order('desc')
        .take(2000)
    ).filter(
      (r) =>
        (!q.status || r.status === q.status) &&
        (!q.workflow || r.workflow === q.workflow),
    )
    let start = 0
    if (q.after) {
      const k = all.findIndex((r) => r.publicId === q.after!.id)
      start = k >= 0 ? k + 1 : all.length
    }
    const page = all.slice(start, start + q.limit)
    const last = page.at(-1)
    const items = []
    for (const d of page) items.push(present(repo, await load(ctx, d), false))
    return out({
      items,
      next:
        start + q.limit < all.length && last
          ? { key: start + q.limit, id: last.publicId }
          : null,
    })
  },
})

export const version = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const c = await counters(ctx, repo)
    const stamp = (
      await ctx.db
        .query('runners')
        .withIndex('by_account_and_name', (q) => q.eq('account', repo.owner))
        .take(200)
    )
      .map(
        (r) =>
          `${r.publicId}:${r.status}:${r.labels.join(',')}:${r.repos?.join(',') ?? '*'}`,
      )
      .join('|')
    return out(
      `${repo.publicId}.p${c.pipelines ?? 0}.${c.pipelineRev ?? 0}.${hash(stamp)}.${await accessStamp(ctx, repo)}`,
    )
  },
})

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const lastFile = query({
  args: { owner: v.string(), name: v.string(), workflow: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    for await (const d of ctx.db
      .query('pipelineRuns')
      .withIndex('by_repoId_and_started', (q) => q.eq('repoId', repo._id))
      .order('desc'))
      if (d.workflow === a.workflow) return out((await load(ctx, d)).file)
    return out(null)
  },
})

export const get = query({
  args: { owner: v.string(), name: v.string(), n: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const doc = await runOf(ctx, repo, a.n)
    return out(await shown(ctx, repo, doc, await load(ctx, doc)))
  },
})

export const log = query({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    job: v.number(),
    step: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const doc = await runOf(ctx, repo, a.n)
    const r = await load(ctx, doc, true)
    const j = r.jobs[a.job - 1] as Job | undefined
    const s = j?.steps[a.step - 1]
    if (!j || !s)
      fail('not_found', `Run ${a.n} has no job ${a.job} step ${a.step}.`)
    return out({
      object: 'pipeline_log',
      run: r.number,
      job: j.name,
      step: s.name,
      status: s.status,
      lines: s.lines.map((l) => ({ text: l.t, level: l.level })),
    })
  },
})

async function queuedFrom(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  from: PipelineRun,
  actor: string,
): Promise<PipelineRun> {
  const at = Date.now()
  const c = await counters(ctx, repo)
  return {
    ...from,
    id: newId('pipeline', at),
    number: (c.pipelineNumber ?? 0) + 1,
    status: 'queued',
    trigger: 'manual',
    actor,
    started: at,
    finished: null,
    annotations: [],
    jobs: from.jobs.map((j) => ({
      ...j,
      status: 'queued',
      runner: '',
      runnerId: null,
      lease: null,
      runsOn: [...(j.runsOn ?? [])],
      duration: 0,
      steps: j.steps.map((s) => ({
        ...s,
        status: 'queued',
        duration: 0,
        lines: [],
        wait: null,
      })),
    })),
    version: 1,
  }
}

export const rerun = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    const from = await load(ctx, await runOf(ctx, repo, a.n))
    const r = await queuedFrom(ctx, repo, from, p.handle)
    await insertRun(ctx, repo, r)
    return finish(
      a.dry,
      present(repo, r, true, undefined, await runnersOf(ctx, repo.owner)),
    )
  },
})

const runsOnArg = v.optional(
  v.object({
    jobs: v.record(v.string(), v.array(v.string())),
    warnings: v.array(v.string()),
  }),
)

export const start = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    workflow: v.string(),
    branch: v.optional(v.string()),
    sha: v.optional(v.string()),
    runsOn: runsOnArg,
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    const r = await startWorkflow(ctx, repo, a.workflow, p.handle, a)
    return finish(
      a.dry,
      present(repo, r, true, undefined, await runnersOf(ctx, repo.owner)),
    )
  },
})

export async function startWorkflow(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  workflow: string,
  actor: string,
  at: {
    branch?: string
    sha?: string
    runsOn?: { jobs: Record<string, Array<string>>; warnings: Array<string> }
    trigger?: 'event'
  } = {},
) {
  let last: PipelineRun | null = null
  for await (const d of ctx.db
    .query('pipelineRuns')
    .withIndex('by_repoId_and_started', (q) => q.eq('repoId', repo._id))
    .order('desc'))
    if (d.workflow === workflow) {
      last = await load(ctx, d)
      break
    }
  if (!last)
    fail(
      'not_found',
      at.trigger === 'event'
        ? `No workflow ${workflow} in ${repo.owner}/${repo.name}: it has never run, so there are no jobs to start.`
        : `No workflow ${workflow} in ${repo.owner}/${repo.name}.`,
      {
        hint: 'GET the pipelines list to see which workflows have run.',
      },
    )
  const branch = at.branch ?? repo.defaultBranch
  const r = await queuedFrom(ctx, repo, last, actor)
  r.branch = branch
  r.sha = at.sha ?? last.sha
  r.title = `${workflow} on ${branch}`
  if (at.runsOn) {
    for (const j of r.jobs) j.runsOn = at.runsOn.jobs[j.name] ?? []
    for (const w of at.runsOn.warnings)
      r.annotations.push({ level: 'warn', text: w, job: '', step: '' })
  }
  if (at.trigger === 'event') {
    r.trigger = 'event'
    r.runsOnPending = true
    r.runsOnFrom = last.number
  }
  await insertRun(ctx, repo, r)
  return r
}

export const claim = mutation({
  args: { owner: v.string(), name: v.string(), runner: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await expireDue(ctx, repo)
    const candidates: Array<Doc<'pipelineRuns'>> = []
    for (const status of ['queued', 'running'])
      candidates.push(
        ...(await ctx.db
          .query('pipelineRuns')
          .withIndex('by_repoId_and_status_and_started', (q) =>
            q.eq('repoId', repo._id).eq('status', status),
          )
          .take(200)),
      )
    candidates.sort((x, y) => x.started - y.started)
    for (const doc of candidates) {
      const r = await load(ctx, doc)
      if (r.runsOnPending) continue
      const ji = r.jobs.findIndex(
        (j) => j.status === 'queued' && !j.runsOn?.length,
      )
      if (ji < 0) continue
      const j = r.jobs[ji]
      j.status = 'running'
      j.runner = a.runner
      if (r.status === 'queued') r.status = 'running'
      r.version++
      await save(ctx, repo, doc, r)
      return out(claimedJob(repo, r, ji))
    }
    return out(null)
  },
})

const lineArg = v.array(
  v.object({
    text: v.string(),
    level: v.optional(v.union(v.null(), v.string())),
  }),
)

export async function applyReport(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  doc: Doc<'pipelineRuns'>,
  a: {
    n: number
    job: number
    step: number
    status: 'running' | 'success' | 'failure' | 'skipped'
    lines?: Array<{ text: string; level?: string | null }>
    duration_ms?: number
  },
) {
  const r = await load(ctx, doc, true)
  const j = r.jobs.at(a.job - 1)
  const s = j?.steps.at(a.step - 1)
  if (!j || !s || a.job < 1 || a.step < 1)
    fail('not_found', `Run ${a.n} has no job ${a.job} step ${a.step}.`)
  const moved = reportStep(r, a.job, a.step, a.status)
  if ('refusal' in moved) fail('invalid_state', moved.refusal)
  if (moved.repeated) return r
  if (a.duration_ms !== undefined) s.duration = a.duration_ms
  for (const l of a.lines ?? [])
    s.lines.push({ t: l.text, level: l.level ?? null })
  if (a.lines?.length) await writeLog(ctx, doc._id, a.job, a.step, s.lines)
  if (a.status === 'failure') {
    const last = [...(a.lines ?? [])].reverse().find((l) => l.level === 'error')
    r.annotations.push({
      level: 'error',
      text: last?.text ?? `${s.name} failed`,
      job: j.name,
      step: s.name,
    })
  }
  const now = Date.now()
  if (j.runnerId && j.status === 'running') j.lease = now + LEASE_MS
  settlePipeline(r, now)
  if (j.status !== 'running') j.lease = null
  r.version++
  await save(ctx, repo, doc, r)
  return r
}

export const report = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    job: v.number(),
    step: v.number(),
    status: v.union(
      v.literal('running'),
      v.literal('success'),
      v.literal('failure'),
      v.literal('skipped'),
    ),
    lines: v.optional(lineArg),
    duration_ms: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.n)
    const r = await applyReport(ctx, repo, doc, a)
    return out(await shown(ctx, repo, doc, r))
  },
})

export const cancel = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.n)
    const r = await load(ctx, doc)
    if (!canMove(pipelineLifecycle, r.status, 'canceled'))
      fail('invalid_state', `Run ${a.n} has already finished.`)
    cancelPipeline(r, Date.now())
    for (const j of r.jobs) j.lease = null
    r.version++
    await save(ctx, repo, doc, r)
    return finish(a.dry, await shown(ctx, repo, doc, r))
  },
})

function waitUntil(expiresAt: string | undefined) {
  const now = Date.now()
  if (expiresAt === undefined) return now + WAIT_DEFAULT_MS
  const t = Date.parse(expiresAt)
  if (!Number.isFinite(t) || t <= now || t > now + WAIT_MAX_MS)
    fail(
      'invalid_request',
      'A wait ends in the future, at most 30 days from now.',
      {
        errors: [
          {
            pointer: '/body/expires_at',
            code: 'out_of_range',
            message: 'An RFC 3339 time after now and within 30 days.',
          },
        ],
      },
    )
  return t
}

export const wait = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    job: v.number(),
    step: v.number(),
    kind: v.union(
      v.literal('person'),
      v.literal('agent'),
      v.literal('approval'),
    ),
    reason: v.string(),
    target: v.optional(v.union(v.null(), v.string())),
    expires_at: v.optional(v.string()),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.n)
    const r = await applyWait(ctx, repo, doc, a, p.handle)
    return finish(a.dry, await shown(ctx, repo, doc, r))
  },
})

export async function applyWait(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  doc: Doc<'pipelineRuns'>,
  a: {
    job: number
    step: number
    kind: 'person' | 'agent' | 'approval'
    reason: string
    target?: string | null
    expires_at?: string
  },
  by: string,
) {
  const r = await load(ctx, doc)
  const w: PipelineWait = {
    kind: a.kind,
    reason: a.reason,
    target: a.target ?? null,
    expires: waitUntil(a.expires_at),
  }
  const refused = waitStep(r, a.job, a.step, w)
  if (refused) fail('invalid_state', refused.refusal)
  r.jobs[a.job - 1].lease = null
  r.version++
  await save(ctx, repo, doc, r)
  await ctx.scheduler.runAt(w.expires, internal.forge.pipelines.expire, {
    runId: doc._id,
    job: a.job,
    step: a.step,
    expires: w.expires,
  })
  if (w.kind !== 'agent') {
    const full = `${repo.owner}/${repo.name}`
    const who = w.target ?? r.actor
    if (w.target || who !== by)
      await notify(ctx, who, {
        kind: 'handoff',
        title: `${r.workflow} #${r.number} waits on you: ${w.reason}`,
        repo: full,
        path: `/${full}/pipelines?n=${r.number}&job=${a.job}`,
      })
  }
  return r
}

export const resume = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    job: v.number(),
    step: v.number(),
    status: v.union(v.literal('success'), v.literal('failure')),
    summary: v.optional(v.string()),
    lines: v.optional(lineArg),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.n)
    const r = await load(ctx, doc, true)
    const now = Date.now()
    const refused = resumeStep(r, a.job, a.step, a.status, now)
    if (refused) fail('invalid_state', refused.refusal)
    const j = r.jobs[a.job - 1]
    const s = j.steps[a.step - 1]
    for (const l of a.lines ?? [])
      s.lines.push({ t: l.text, level: l.level ?? null })
    if (a.summary)
      s.lines.push({
        t: `Resumed by ${p.handle}: ${a.summary}`,
        level: a.status === 'failure' ? 'error' : 'ok',
      })
    if (a.lines?.length || a.summary)
      await writeLog(ctx, doc._id, a.job, a.step, s.lines)
    if (a.status === 'failure')
      r.annotations.push({
        level: 'error',
        text: a.summary ?? `${s.name} failed while it waited`,
        job: j.name,
        step: s.name,
      })
    if (j.runnerId && j.status === 'running') j.lease = now + LEASE_MS
    r.version++
    await save(ctx, repo, doc, r)
    return finish(a.dry, await shown(ctx, repo, doc, r))
  },
})

async function expireOne(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  doc: Doc<'pipelineRuns'>,
  job: number,
  step: number,
  expires: number,
) {
  const r = await load(ctx, doc)
  const s = r.jobs.at(job - 1)?.steps.at(step - 1)
  const why = s?.wait?.reason ?? ''
  if (!s || !expireWait(r, job, step, expires, Date.now())) return false
  for (const j of r.jobs) j.lease = null
  r.annotations.push({
    level: 'error',
    text: `Nobody resumed ${s.name} before its wait ran out: ${why}`,
    job: r.jobs[job - 1].name,
    step: s.name,
  })
  r.version++
  await save(ctx, repo, doc, r)
  return true
}

export async function expireDue(ctx: MutationCtx, repo: Doc<'repos'>) {
  const now = Date.now()
  for (const status of ['waiting', 'running'])
    for (const doc of await ctx.db
      .query('pipelineRuns')
      .withIndex('by_repoId_and_status_and_started', (q) =>
        q.eq('repoId', repo._id).eq('status', status),
      )
      .take(200)) {
      const r = await load(ctx, doc)
      for (const [ji, j] of r.jobs.entries())
        for (const [si, st] of j.steps.entries())
          if (st.status === 'waiting' && st.wait && st.wait.expires <= now) {
            const fresh = (await ctx.db.get('pipelineRuns', doc._id))!
            await expireOne(ctx, repo, fresh, ji + 1, si + 1, st.wait.expires)
          }
    }
}

export const expire = internalMutation({
  args: {
    runId: v.id('pipelineRuns'),
    job: v.number(),
    step: v.number(),
    expires: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const doc = await ctx.db.get('pipelineRuns', a.runId)
    if (!doc) return null
    const repo = await ctx.db.get('repos', doc.repoId)
    if (!repo) return null
    await expireOne(ctx, repo, doc, a.job, a.step, a.expires)
    return null
  },
})

export async function requeueExpired(
  ctx: MutationCtx,
  limit: number,
  only?: (repo: Doc<'repos'>) => boolean,
) {
  const now = Date.now()
  let moved = 0
  for (const status of ['running', 'waiting'] as const)
    for (const doc of await ctx.db
      .query('pipelineRuns')
      .withIndex('by_status_and_started', (q) => q.eq('status', status))
      .take(limit)) {
      const repo = await ctx.db.get('repos', doc.repoId)
      if (!repo || (only && !only(repo))) continue
      const r = await load(ctx, doc)
      let changed = false
      for (const [ji, j] of r.jobs.entries())
        for (const [si, st] of j.steps.entries())
          if (st.status === 'waiting' && st.wait && st.wait.expires <= now) {
            const why = st.wait.reason
            if (expireWait(r, ji + 1, si + 1, st.wait.expires, now)) {
              for (const x of r.jobs) x.lease = null
              r.annotations.push({
                level: 'error',
                text: `Nobody resumed ${st.name} before its wait ran out: ${why}`,
                job: j.name,
                step: st.name,
              })
              changed = true
            }
          }
      for (const [ji, j] of r.jobs.entries())
        if (j.status === 'running' && j.lease && j.lease <= now) {
          const who = j.runner
          if (requeueJob(r, ji + 1)) {
            j.runner = ''
            j.runnerId = null
            j.lease = null
            r.annotations.push({
              level: 'warn',
              text: `Runner ${who} stopped answering, so the job went back to the queue.`,
              job: j.name,
              step: '',
            })
            changed = true
            moved++
          }
        }
      if (changed) {
        r.version++
        await save(ctx, repo, doc, r)
      }
    }
  return moved
}

export const sweepLeases = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requeueExpired(ctx, 500)
    return null
  },
})

export async function startPipelineForEvent(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  at: { workflow: string; branch: string; sha: string; actor: string },
) {
  return await startWorkflow(ctx, repo, at.workflow, at.actor, {
    branch: at.branch,
    sha: at.sha,
    trigger: 'event',
  })
}

export const pendingRunsOn = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await system(ctx)
    const found = []
    for (const d of await ctx.db
      .query('pipelineRuns')
      .withIndex('by_status_and_started', (q) => q.eq('status', 'queued'))
      .take(500)) {
      const r = JSON.parse(d.json) as PipelineRun
      if (!r.runsOnPending) continue
      const repo = await ctx.db.get('repos', d.repoId)
      if (repo)
        found.push({
          owner: repo.owner,
          name: repo.name,
          number: r.number,
          file: r.file,
          sha: r.sha,
        })
    }
    return out(found)
  },
})

export const setRunsOn = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    n: v.number(),
    read: v.union(
      v.null(),
      v.object({
        jobs: v.record(v.string(), v.array(v.string())),
        warnings: v.array(v.string()),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const sys = await system(ctx)
    const repo = await resolve(ctx, a.owner, a.name, sys)
    const doc = await runOf(ctx, repo, a.n)
    const r = await load(ctx, doc)
    if (!r.runsOnPending) return out(null)
    applyRunsOn(r, a.read)
    r.version++
    await save(ctx, repo, doc, r)
    return out(null)
  },
})
