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

export function isTerminal<S extends string>(m: Machine<S>, s: S) {
  return m.moves[s].length === 0
}

export type ChangeState = 'draft' | 'open' | 'landed' | 'abandoned'

export const changeLifecycle = machine<ChangeState>('change', {
  draft: ['open', 'abandoned'],
  open: ['landed', 'abandoned'],
  abandoned: ['draft', 'open'],
  landed: [],
})

export type ChangeAction = 'ready' | 'abandon' | 'restore' | 'land'

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

export type PipelineStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'canceled'

export const pipelineLifecycle = machine<PipelineStatus>('pipeline', {
  queued: ['running', 'canceled'],
  running: ['queued', 'waiting', 'success', 'failure', 'canceled'],
  waiting: ['running', 'canceled', 'failure'],
  success: [],
  failure: [],
  canceled: [],
})

export type PipelineStepStatus = PipelineStatus | 'skipped'

export const pipelineStepLifecycle = machine<PipelineStepStatus>(
  'pipeline step',
  {
    queued: ['running', 'success', 'failure', 'skipped', 'canceled'],
    running: ['queued', 'running', 'waiting', 'success', 'failure', 'canceled'],
    waiting: ['running', 'success', 'failure', 'canceled'],
    success: [],
    failure: [],
    skipped: [],
    canceled: [],
  },
)

export const pipelineDone = (s: string) =>
  s === 'success' || s === 'failure' || s === 'canceled' || s === 'skipped'

type StepLike = {
  status: string
  duration: number
  wait?: PipelineWait | null
}
type JobLike = { status: string; duration: number; steps: Array<StepLike> }

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

export function cancelPipeline(
  r: { status: string; finished: number | null; jobs: Array<JobLike> },
  at: number,
) {
  r.status = 'canceled'
  r.finished = at
  for (const j of r.jobs) {
    if (!pipelineDone(j.status)) j.status = 'canceled'
    for (const s of j.steps)
      if (!pipelineDone(s.status)) {
        s.status = 'canceled'
        if ('wait' in s) (s as { wait?: unknown }).wait = null
      }
  }
}

export type PipelineWait = {
  kind: 'person' | 'agent' | 'approval'
  reason: string
  target: string | null
  expires: number
}

type WaitStep = StepLike & { wait?: PipelineWait | null }
type WaitJob = JobLike & { steps: Array<WaitStep> }
type WaitRun = {
  number: number
  status: string
  finished: number | null
  jobs: Array<WaitJob>
}

function runStatusAfterWait(r: WaitRun) {
  if (r.jobs.some((j) => j.status === 'running')) return 'running'
  if (r.jobs.some((j) => j.status === 'waiting')) return 'waiting'
  return r.status
}

export function waitStep(
  r: WaitRun,
  job: number,
  step: number,
  wait: PipelineWait,
): { refusal: string } | null {
  const j = r.jobs.at(job - 1)
  const s = j?.steps.at(step - 1)
  if (!j || !s || job < 1 || step < 1)
    return { refusal: `Run ${r.number} has no job ${job} step ${step}.` }
  if (pipelineDone(r.status))
    return { refusal: `Run ${r.number} has already finished.` }
  if (
    !canMove(
      pipelineStepLifecycle,
      s.status as PipelineStepStatus,
      'waiting',
    ) ||
    s.status !== 'running'
  )
    return {
      refusal: `Step ${step} of job ${job} is ${s.status}; only a running step can wait.`,
    }
  if (!canMove(pipelineLifecycle, j.status as PipelineStatus, 'waiting'))
    return { refusal: `Job ${job} of run ${r.number} is ${j.status}.` }
  s.status = 'waiting'
  s.wait = wait
  j.status = 'waiting'
  const to = runStatusAfterWait(r)
  if (to !== r.status) {
    if (!canMove(pipelineLifecycle, r.status as PipelineStatus, to as never))
      return { refusal: `Run ${r.number} is ${r.status}.` }
    r.status = to
  }
  return null
}

export function resumeStep(
  r: WaitRun,
  job: number,
  step: number,
  to: 'success' | 'failure',
  at: number,
): { refusal: string } | null {
  const j = r.jobs.at(job - 1)
  const s = j?.steps.at(step - 1)
  if (!j || !s || job < 1 || step < 1)
    return { refusal: `Run ${r.number} has no job ${job} step ${step}.` }
  if (s.status !== 'waiting')
    return {
      refusal: `Step ${step} of job ${job} is ${s.status}; only a waiting step resumes.`,
    }
  for (const [m, from, next] of [
    [pipelineStepLifecycle, s.status, 'running'],
    [pipelineStepLifecycle, 'running', to],
    [pipelineLifecycle, j.status, 'running'],
  ] as const)
    if (!canMove(m as Machine<string>, from, next))
      return { refusal: `Step ${step} of job ${job} cannot become ${to}.` }
  s.status = to
  s.wait = null
  j.status = 'running'
  if (r.status === 'waiting') {
    if (!canMove(pipelineLifecycle, 'waiting', 'running'))
      return { refusal: `Run ${r.number} cannot resume.` }
    r.status = 'running'
  }
  if (to === 'failure')
    for (const rest of j.steps.slice(step))
      if (rest.status === 'queued') rest.status = 'skipped'
  settlePipeline(r, at)
  return null
}

export function expireWait(
  r: WaitRun,
  job: number,
  step: number,
  expires: number,
  at: number,
): boolean {
  const j = r.jobs.at(job - 1)
  const s = j?.steps.at(step - 1)
  if (!j || !s || s.status !== 'waiting' || s.wait?.expires !== expires)
    return false
  if (!canMove(pipelineLifecycle, r.status as PipelineStatus, 'failure'))
    return false
  s.status = 'failure'
  s.wait = null
  for (const rest of j.steps.slice(step))
    if (rest.status === 'queued') rest.status = 'skipped'
  j.status = 'failure'
  j.duration = j.steps.reduce((t, x) => t + x.duration, 0)
  for (const other of r.jobs) {
    if (!pipelineDone(other.status)) other.status = 'canceled'
    for (const x of other.steps)
      if (!pipelineDone(x.status)) x.status = 'canceled'
  }
  r.status = 'failure'
  r.finished = at
  return true
}

export function requeueJob(
  r: { status: string; jobs: Array<JobLike> },
  job: number,
): boolean {
  const j = r.jobs.at(job - 1)
  if (!j || !canMove(pipelineLifecycle, j.status as PipelineStatus, 'queued'))
    return false
  if (j.status !== 'running') return false
  j.status = 'queued'
  for (const s of j.steps)
    if (
      s.status === 'running' &&
      canMove(pipelineStepLifecycle, 'running', 'queued')
    )
      s.status = 'queued'
  if (
    r.status === 'running' &&
    !r.jobs.some((x) => x.status === 'running' || x.status === 'waiting') &&
    !r.jobs.some((x) => pipelineDone(x.status))
  )
    r.status = 'queued'
  return true
}

export function jobWait(j: { steps: Array<{ wait?: PipelineWait | null }> }) {
  return j.steps.find((s) => s.wait)?.wait ?? null
}

export const WAIT_DEFAULT_MS = 7 * 86_400_000
export const WAIT_MAX_MS = 30 * 86_400_000

export type DeliveryState = 'pending' | 'succeeded' | 'failed'

export const deliveryLifecycle = machine<DeliveryState>('delivery', {
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
})

export type UploadState = 'pending' | 'uploaded'

export const uploadLifecycle = machine<UploadState>('upload', {
  pending: ['uploaded'],
  uploaded: ['pending'],
})

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

export type DeviceStatus = 'pending' | 'approved' | 'denied'

export const deviceLifecycle = machine<DeviceStatus>('device code', {
  pending: ['approved', 'denied'],
  approved: [],
  denied: [],
})

export type GrantState = 'pending' | 'active' | 'revoked'

export const grantLifecycle = machine<GrantState>('grant', {
  pending: ['active', 'revoked'],
  active: ['revoked'],
  revoked: [],
})
