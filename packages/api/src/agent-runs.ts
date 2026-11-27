// Jobs for an agent on someone's own machine, queued as pipeline runs so a
// runner takes them like any job and they show in Pipelines: a hand-off
// (start a T3 Code thread for an issue or change) and an AI review (read a
// change's patch set and post findings on it). The run's `file` says which.
import type { Planned } from './actions'

export const AGENT_PREFIX = 'cobalt:'

export type AgentJob =
  | { kind: 'handoff'; subject: string; to: 't3' }
  | { kind: 'review'; change: number; patchSet: number }

export function agentJobOf(file: string): AgentJob | null {
  const h = /^cobalt:handoff\/([^/]+)\/(t3)$/.exec(file)
  if (h) return { kind: 'handoff', subject: decodeURIComponent(h[1]), to: 't3' }
  const r = /^cobalt:review\/(\d+)\/(\d+)$/.exec(file)
  if (r) return { kind: 'review', change: Number(r[1]), patchSet: Number(r[2]) }
  return null
}

const job = (name: string, label: string, step: string) => ({
  name,
  runner: '',
  status: 'queued' as const,
  duration: 0,
  runsOn: [label],
  runnerId: null,
  lease: null,
  steps: [
    {
      name: step,
      status: 'queued' as const,
      duration: 0,
      lines: [],
      wait: null,
    },
  ],
})

/** Hand `subject` (an issue or change number, or run:N) to T3 Code. */
export function handoffPlan(a: {
  subject: string
  title: string
  branch: string
  sha: string
}): Planned {
  const ref = a.subject.startsWith('run:') ? a.subject : `#${a.subject}`
  return {
    workflow: `Hand off ${ref} to T3 Code`,
    file: `${AGENT_PREFIX}handoff/${encodeURIComponent(a.subject)}/t3`,
    branch: a.branch,
    sha: a.sha,
    trigger: 'manual',
    jobs: [
      job('Hand off', 't3', `Start a T3 Code thread: ${a.title}`.slice(0, 200)),
    ],
    annotations: [],
  }
}

/** An AI review of patch set `patchSet` of change `change`. */
export function reviewPlan(a: {
  change: number
  patchSet: number
  title: string
  branch: string
  sha: string
}): Planned {
  return {
    workflow: `AI review #${a.change}`,
    file: `${AGENT_PREFIX}review/${a.change}/${a.patchSet}`,
    branch: a.branch,
    sha: a.sha,
    trigger: 'change',
    jobs: [
      job(
        'Review',
        'reviewer',
        `Review patch set ${a.patchSet}: ${a.title}`.slice(0, 200),
      ),
    ],
    annotations: [],
  }
}
