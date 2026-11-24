import { settleRunsOn } from '../runs-on'
import { Effect } from 'effect'
import { z } from 'zod'
import { MAX_CONCURRENCY, MAX_LABELS } from '../runners'
import { Domain, defineOp, reply } from '../registry'
import * as S from '../schemas'

/**
 * Runners: machines that take pipeline jobs. A person or an organization's
 * owner registers one and gets its token once; the machine then sends
 * heartbeats, claims jobs whose `runs-on` its labels cover, and reports each
 * step with that token. Self-hosted and hosted runners use the same calls.
 */

const manage = {
  tags: ['runners'],
  auth: 'required' as const,
  scopes: ['runners:manage' as const],
}
const asRunner = {
  tags: ['runners'],
  auth: 'required' as const,
  pool: 'write' as const,
  safety: 'write' as const,
  dryRun: false,
}

const idParams = z.object({
  id: z.string().describe('The runner `rnr_` id'),
})

const fields = {
  labels: z
    .array(z.string().min(1).max(50))
    .max(MAX_LABELS)
    .describe(
      'What the machine offers, such as `macos`, `arm64`, `xcode-16`. Stored lowercase',
    ),
  repos: z
    .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/))
    .max(500)
    .nullable()
    .describe(
      '`owner/name` of the account it may serve; null for all of them, now and later',
    ),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
}

export const createRunner = defineOp({
  ...manage,
  id: 'runners.create',
  secretResponse: true,
  summary: 'Register a runner',
  description:
    "The response is the only time the runner's token (`secret`) is shown: put it in `CB_RUNNER_TOKEN` on the machine. It reads the repositories the runner may serve, claims and reports their jobs, and nothing else. A person registers runners for themself; an organization's owner or admin for the organization.",
  method: 'POST',
  path: '/runners',
  pool: 'write',
  safety: 'write',
  idempotent: false,
  dryRun: true,
  body: z.strictObject({
    name: z.string().min(1).max(80),
    account: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('The account it serves; the one you act as if left out'),
    kind: z.enum(['self-hosted', 'hosted']).optional(),
    provider: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .nullable()
      .optional()
      .describe('For a hosted runner: `blacksmith`, `depot`, ...'),
    labels: fields.labels.optional(),
    repos: fields.repos.optional(),
    concurrency: fields.concurrency.optional(),
  }),
  response: S.Runner,
  status: 201,
  errors: ['not_found', 'forbidden', 'invalid_request', 'limit_reached'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const r = yield* run((d) =>
        d.createRunner(ctx.principal, ctx.body, ctx.dryRun),
      )
      return reply(r, {
        status: ctx.dryRun ? 200 : 201,
        headers: { location: r.url, 'cache-control': 'no-store' },
      })
    }),
})

export const listRunners = defineOp({
  ...manage,
  id: 'runners.list',
  summary: 'Runners of an account',
  description:
    'Newest first, with their labels, status and the jobs they hold. Never includes a secret.',
  method: 'GET',
  path: '/runners',
  pool: 'read',
  safety: 'read',
  idempotent: true,
  query: z.strictObject({
    account: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('The one you act as if left out'),
  }),
  response: S.listOf(S.Runner),
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run((d) =>
        d.listRunners(ctx.principal, ctx.query.account),
      )
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const getRunner = defineOp({
  ...manage,
  id: 'runners.get',
  summary: 'One runner',
  method: 'GET',
  path: '/runners/{id}',
  params: idParams,
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.Runner,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.getRunner(ctx.principal, ctx.params.id))
    }),
})

export const updateRunner = defineOp({
  ...manage,
  id: 'runners.update',
  summary: 'Change a runner',
  description:
    'Its name, labels, repositories or concurrency. Its token follows the repositories it may serve.',
  method: 'PATCH',
  path: '/runners/{id}',
  params: idParams,
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  body: z.strictObject({
    name: z.string().min(1).max(80).optional(),
    labels: fields.labels.optional(),
    repos: fields.repos.optional(),
    concurrency: fields.concurrency.optional(),
  }),
  response: S.Runner,
  errors: ['not_found', 'forbidden', 'invalid_request', 'invalid_state'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.updateRunner(ctx.principal, ctx.params.id, ctx.body, ctx.dryRun),
      )
    }),
})

export const deleteRunner = defineOp({
  ...manage,
  id: 'runners.delete',
  summary: 'Revoke a runner',
  description:
    'Disables it and revokes its token in the same write: its next request is refused. Jobs it held go back to the queue when their lease runs out.',
  method: 'DELETE',
  path: '/runners/{id}',
  params: idParams,
  pool: 'write',
  safety: 'destructive',
  idempotent: true,
  dryRun: true,
  response: S.Runner,
  errors: ['not_found', 'forbidden'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.deleteRunner(ctx.principal, ctx.params.id, ctx.dryRun),
      )
    }),
})

export const runnerHeartbeat = defineOp({
  ...asRunner,
  scopes: ['runners:claim'],
  id: 'runners.heartbeat',
  summary: 'Say the runner is alive, as the runner',
  description:
    'Send one every 30 seconds with the runner token. It extends the lease on every job the runner is running. A runner silent for 90 seconds is shown offline.',
  method: 'POST',
  path: '/runners/heartbeat',
  idempotent: true,
  response: S.Runner,
  errors: ['forbidden'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.runnerHeartbeat(ctx.principal))
    }),
})

export const runnerClaim = defineOp({
  ...asRunner,
  scopes: ['runners:claim'],
  id: 'runners.claim',
  summary: 'Take the next job, as the runner',
  description:
    "The oldest queued job in a repository the runner may serve whose `runs-on` labels are all among the runner's (case does not matter). `204` when there is none, or when the runner already holds `concurrency` jobs. The job is leased for 15 minutes; every report and heartbeat extends it.",
  method: 'POST',
  path: '/runners/claim',
  idempotent: false,
  response: S.PipelineJob,
  errors: ['forbidden'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      // Labels a trigger left unread are read first, so no job goes by a stale one.
      yield* run((d) => settleRunsOn(d))
      const j = yield* run((d) => d.runnerClaim(ctx.principal))
      return j ?? reply(null as never, { status: 204 })
    }),
})

export const runnerReport = defineOp({
  ...asRunner,
  scopes: ['runners:report'],
  id: 'runners.report',
  summary: 'Report a step of a job it holds, as the runner',
  description:
    'The same report as `pipelines.report`, made with the runner token for a job this runner claimed.',
  method: 'POST',
  path: '/runners/report',
  idempotent: false,
  body: z.strictObject({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    run: z.number().int().min(1),
    job: z.number().int().min(1),
    step: z.number().int().min(1),
    status: z.enum(['running', 'success', 'failure', 'skipped']),
    lines: z
      .array(
        z.strictObject({
          text: z.string().max(4000),
          level: z
            .enum(['cmd', 'info', 'ok', 'warn', 'error'])
            .nullable()
            .optional(),
        }),
      )
      .max(1000)
      .optional(),
    duration_ms: z.number().int().min(0).optional(),
  }),
  response: S.PipelineRun,
  errors: ['not_found', 'forbidden', 'invalid_state'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.runnerReport(ctx.principal, ctx.body))
    }),
})

export const runnerWait = defineOp({
  ...asRunner,
  scopes: ['runners:report'],
  id: 'runners.wait',
  summary: 'Pause a step of a job it holds, as the runner',
  description:
    "A step that waits on a person, an approval or an outside agent, paused by the runner running it, with the runner token. The job keeps the runner and is never claimed again; whom it waits on is told; if nobody resumes it by `expires_at` (7 days by default, 30 at most) the step and the run fail. Resuming takes a login with `repo:write` (`pipelines.resume`): a runner's token cannot answer its own wait.",
  method: 'POST',
  path: '/runners/wait',
  idempotent: true,
  body: z.strictObject({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    run: z.number().int().min(1),
    job: z.number().int().min(1),
    step: z.number().int().min(1),
    kind: z.enum(['person', 'agent', 'approval']),
    reason: z.string().min(1).max(500),
    target: z.string().min(1).max(100).nullable().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  }),
  response: S.PipelineRun,
  errors: ['not_found', 'forbidden', 'invalid_state', 'invalid_request'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.runnerWait(ctx.principal, ctx.body))
    }),
})

export const runnerJobs = defineOp({
  tags: ['runners'],
  auth: 'required',
  id: 'runners.jobs',
  summary: 'The jobs a runner holds',
  description:
    'Running or waiting. Readable by the runner itself and by members of its account.',
  method: 'GET',
  path: '/runners/{id}/jobs',
  params: idParams,
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.listOf(S.RunnerJob),
  errors: ['not_found', 'forbidden'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run((d) => d.runnerJobs(ctx.principal, ctx.params.id))
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const runnerOps = [
  createRunner,
  listRunners,
  runnerHeartbeat,
  runnerClaim,
  runnerReport,
  runnerWait,
  getRunner,
  updateRunner,
  deleteRunner,
  runnerJobs,
]
