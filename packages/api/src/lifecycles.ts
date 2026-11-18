/**
 * Every record that moves through states, and the moves it may make. Each
 * is a table read by both the in-memory domain and the Convex functions, so
 * the two cannot drift: a write asks `canMove` before it changes a state,
 * and a state not reachable here is never written.
 *
 * Plain JavaScript: the Convex functions import it too.
 */

export type Machine<S extends string> = {
  readonly name: string
  readonly moves: { readonly [K in S]: ReadonlyArray<S> }
}

function machine<S extends string>(
  name: string,
  moves: { readonly [K in S]: ReadonlyArray<S> },
): Machine<S> {
  return { name, moves }
}

export function canMove<S extends string>(m: Machine<S>, from: S, to: S) {
  return m.moves[from].includes(to)
}

/** A state with no way out. */
export function isTerminal<S extends string>(m: Machine<S>, s: S) {
  return m.moves[s].length === 0
}

// ---- Changes -----------------------------------------------------------------

export type ChangeState = 'draft' | 'open' | 'landed' | 'abandoned'

/** A change. Abandoning remembers where it was, so restoring returns there. */
export const changeLifecycle = machine<ChangeState>('change', {
  draft: ['open', 'abandoned'],
  open: ['landed', 'abandoned'],
  abandoned: ['draft', 'open'],
  landed: [],
})

export type ChangeAction = 'ready' | 'abandon' | 'restore' | 'land'

/**
 * Where an action takes a change from where it is, or null when it cannot.
 * `abandonedFrom` is the state it was abandoned from (absent on changes
 * abandoned before it was kept: those were open or draft, and reopen open).
 */
export function changeTarget(
  action: ChangeAction,
  c: { state: ChangeState; abandonedFrom?: 'draft' | 'open' | null },
): ChangeState | null {
  const to: ChangeState =
    action === 'ready'
      ? 'open'
      : action === 'abandon'
        ? 'abandoned'
        : action === 'land'
          ? 'landed'
          : (c.abandonedFrom ?? 'open')
  if (action === 'ready' && c.state !== 'draft') return null
  if (action === 'restore' && c.state !== 'abandoned') return null
  return canMove(changeLifecycle, c.state, to) ? to : null
}

// ---- Long operations and their steps ------------------------------------------

export type OperationState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export const operationLifecycle = machine<OperationState>('operation', {
  queued: ['running', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
})

export type StepState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'

export const landingStepLifecycle = machine<StepState>('landing step', {
  pending: ['running', 'skipped'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  skipped: [],
})

// ---- Pipelines ---------------------------------------------------------------

export type PipelineStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'canceled'

/** A pipeline run and each of its jobs. */
export const pipelineLifecycle = machine<PipelineStatus>('pipeline', {
  queued: ['running', 'canceled'],
  running: ['success', 'failure', 'canceled'],
  success: [],
  failure: [],
  canceled: [],
})

export type PipelineStepStatus = PipelineStatus | 'skipped'

/** One step of a job, as its runner reports it. */
export const pipelineStepLifecycle = machine<PipelineStepStatus>(
  'pipeline step',
  {
    queued: ['running', 'success', 'failure', 'skipped', 'canceled'],
    running: ['running', 'success', 'failure', 'canceled'],
    success: [],
    failure: [],
    skipped: [],
    canceled: [],
  },
)

export const pipelineDone = (s: string) =>
  s === 'success' || s === 'failure' || s === 'canceled' || s === 'skipped'

type StepLike = { status: string; duration: number }
type JobLike = { status: string; duration: number; steps: Array<StepLike> }

/**
 * A runner's report on one step, applied to its job: checks the move, then
 * finishes what it finishes. A failed step skips the rest of its job; a job
 * whose steps are all over is over; a run whose jobs are all over is over.
 * A report that repeats the step's state is answered as it is, so a runner
 * may retry. Returns a refusal, or null once applied.
 */
export function reportStep(
  r: { number: number; status: string; jobs: Array<JobLike> },
  job: number,
  step: number,
  to: 'running' | 'success' | 'failure' | 'skipped',
): { refusal: string } | { repeated: boolean } {
  const j = r.jobs[job - 1]
  const s = j.steps[step - 1]
  if (pipelineDone(r.status))
    return { refusal: `Run ${r.number} has already finished.` }
  if (j.status !== 'running')
    return {
      refusal: `Job ${job} of run ${r.number} is ${j.status}; a runner claims it first.`,
    }
  if (s.status === to && to !== 'running') return { repeated: true }
  if (
    !canMove(
      pipelineStepLifecycle,
      s.status as PipelineStepStatus,
      to as PipelineStepStatus,
    )
  )
    return {
      refusal: `Step ${step} of job ${job} is ${s.status}; it cannot become ${to}.`,
    }
  const earlier = j.steps
    .slice(0, step - 1)
    .findIndex((x) => !pipelineDone(x.status))
  if (earlier >= 0)
    return {
      refusal: `Step ${step} of job ${job} cannot be reported yet: step ${earlier + 1} is ${j.steps[earlier].status}.`,
    }
  s.status = to
  if (to === 'failure')
    for (const rest of j.steps.slice(step))
      if (rest.status === 'queued') rest.status = 'skipped'
  return { repeated: false }
}

/** After a step changed: finish the job and the run when everything is over. */
export function settlePipeline(
  r: { status: string; finished: number | null; jobs: Array<JobLike> },
  at: number,
) {
  for (const j of r.jobs)
    if (
      j.status === 'running' &&
      j.steps.every((x) => pipelineDone(x.status))
    ) {
      j.status = j.steps.some((x) => x.status === 'failure')
        ? 'failure'
        : 'success'
      j.duration = j.steps.reduce((t, x) => t + x.duration, 0)
    }
  if (r.status === 'running' && r.jobs.every((x) => pipelineDone(x.status))) {
    r.status = r.jobs.some((x) => x.status === 'failure')
      ? 'failure'
      : 'success'
    r.finished = at
  }
}

/** Cancel a run: every job and step not yet over is canceled with it. */
export function cancelPipeline(
  r: { status: string; finished: number | null; jobs: Array<JobLike> },
  at: number,
) {
  r.status = 'canceled'
  r.finished = at
  for (const j of r.jobs) {
    if (!pipelineDone(j.status)) j.status = 'canceled'
    for (const s of j.steps) if (!pipelineDone(s.status)) s.status = 'canceled'
  }
}

// ---- Webhook deliveries ---------------------------------------------------------

export type DeliveryState = 'pending' | 'succeeded' | 'failed'

export const deliveryLifecycle = machine<DeliveryState>('delivery', {
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
})

// ---- Uploads -------------------------------------------------------------------

export type UploadState = 'pending' | 'uploaded'

/**
 * An upload gets its file once; once it has it, it is attached once. It goes
 * back to pending only when its bytes could not be kept after it was marked
 * (`unreceive`), never by a save.
 */
export const uploadLifecycle = machine<UploadState>('upload', {
  pending: ['uploaded'],
  uploaded: ['pending'],
})

/**
 * Whether `next` follows from `now`: the file arrives once, and an upload is
 * attached to one thing only. Saving what it already is changes nothing.
 */
export function uploadMoveRefusal(
  now: { state: UploadState; sha256: string | null; attachedTo: string | null },
  next: {
    state: UploadState
    sha256: string | null
    attachedTo: string | null
  },
): string | null {
  if (now.state !== next.state) {
    if (
      !canMove(uploadLifecycle, now.state, next.state) ||
      next.state === 'pending'
    )
      return `The upload is ${now.state}; it cannot become ${next.state}.`
  } else if (now.state === 'uploaded' && now.sha256 !== next.sha256)
    return 'This upload already has its file.'
  if (now.attachedTo !== next.attachedTo) {
    if (now.attachedTo !== null)
      return `The upload is already attached to ${now.attachedTo}.`
    if (next.state !== 'uploaded')
      return 'An upload is attached only once its file has arrived.'
  }
  return null
}

// ---- Device sign-in ----------------------------------------------------------

export type DeviceStatus = 'pending' | 'approved' | 'denied'

/** A device code waits for a person, who approves or denies it once. */
export const deviceLifecycle = machine<DeviceStatus>('device code', {
  pending: ['approved', 'denied'],
  approved: [],
  denied: [],
})

// ---- Production confirmations ----------------------------------------------------------------

export type GrantState = 'pending' | 'active' | 'revoked'

export const grantLifecycle = machine<GrantState>('grant', {
  pending: ['active', 'revoked'],
  active: ['revoked'],
  revoked: [],
})
