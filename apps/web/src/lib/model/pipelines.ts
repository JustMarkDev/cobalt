// Pipeline runs as the Pipelines tab shows them (`lib/pipeline.ts` turns
// the API's runs into these).

export type RunStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'waiting'
  | 'queued'
  | 'canceled'
export type StepStatus = RunStatus | 'skipped'

export type Run = {
  id: number
  workflow: string
  title: string
  branch: string
  sha: string
  status: RunStatus
  duration: string
  when: string
  actor: string
  trigger: 'push' | 'change' | 'tag' | 'schedule' | 'manual' | 'event'
}

/** What a waiting step waits for. */
export type Wait = {
  kind: 'person' | 'agent' | 'approval'
  reason: string
  target: string | null
  expiresAt: string
}

export type Level = 'cmd' | 'info' | 'dim' | 'ok' | 'warn' | 'error'

export type LogLine = { t: string; level?: Level }

export type Step = {
  name: string
  status: StepStatus
  time: string
  lines: Array<LogLine>
  wait: Wait | null
}

export type Job = {
  name: string
  runner: string
  status: StepStatus
  time: string
  steps: Array<Step>
  /** The labels it asked for (`runs-on`). */
  runsOn: Array<string>
  /** While queued: the labels no runner of the repository has, or null. */
  waitingFor: Array<string> | null
}

export type RunDetail = {
  run: Run
  file: string
  jobs: Array<Job>
  /** What a person should look at first, with where it came from. */
  annotations: Array<{
    level: 'error' | 'warn'
    text: string
    job: string
    step: string
  }>
}

// ---------------------------------------------------------------------------
// Runs per repository
// ---------------------------------------------------------------------------

export function failureOf(detail: RunDetail) {
  for (const j of detail.jobs)
    for (const s of j.steps)
      if (s.status === 'failure') {
        const first = s.lines.find((l) => l.level === 'error')
        return {
          job: j.name,
          step: s.name,
          text: first?.t ?? 'The step failed.',
        }
      }
  return null
}
