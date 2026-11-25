import { jobWait } from './lifecycles'
import type { PipelineWait } from './lifecycles'
import { waitingForLabels } from './runners'
import type { RunnerLike } from './runners'
import { newId } from './ids'
import type { PipelineRunRec } from './domain/records'

const iso = (t: number) => new Date(t).toISOString()

const presentWait = (w: PipelineWait | null | undefined) =>
  w
    ? {
        kind: w.kind,
        reason: w.reason,
        target: w.target,
        expires_at: iso(w.expires),
      }
    : null

export function presentPipelineRun(a: {
  run: PipelineRunRec
  repo: { owner: string; name: string }
  repoUrl: string
  htmlUrl: string
  detail: boolean
  runners?: ReadonlyArray<RunnerLike>
  lineCount?: (job: number, step: number) => number | undefined
}) {
  const { run: r, repo } = a
  const base = `${a.repoUrl}/pipelines/${r.number}`
  return {
    object: 'pipeline_run' as const,
    id: r.id,
    number: r.number,
    url: base,
    html_url: `${a.htmlUrl}/${repo.owner}/${repo.name}/pipelines?n=${r.number}`,
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
    jobs: a.detail
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
              ? waitingForLabels(
                  j.runsOn ?? [],
                  [...(a.runners ?? [])],
                  repo.owner,
                  repo.name,
                )
              : null,
          wait: presentWait(jobWait(j)),
          steps: j.steps.map((s, si) => ({
            name: s.name,
            status: s.status,
            duration_ms: s.duration,
            lines: a.lineCount?.(ji + 1, si + 1) ?? s.lines.length,
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

export function presentClaimedJob(
  repoUrl: string,
  r: PipelineRunRec,
  ji: number,
) {
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
    url: `${repoUrl}/pipelines/${r.number}/jobs/${ji + 1}`,
    runs_on: [...(j.runsOn ?? [])],
    runner_id: j.runnerId ?? null,
    lease_expires_at: j.lease ? iso(j.lease) : null,
  }
}

export function queuedCopy(
  from: PipelineRunRec,
  a: { number: number; actor: string; at: number },
): PipelineRunRec {
  return {
    ...from,
    id: newId('pipeline', a.at),
    number: a.number,
    status: 'queued',
    trigger: 'manual',
    actor: a.actor,
    started: a.at,
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
