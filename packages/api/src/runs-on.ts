import { runsOnOf } from './workflow'
import type { DomainPort } from './domain/port'

/**
 * A run a trigger started is made inside the write that lands a change,
 * where git cannot be read. So its jobs are queued with the last run's
 * labels, marked pending, and no runner takes them until this has read
 * `runs-on` from the workflow file at the run's own commit. Called after a
 * land and before every claim, so a stale label never routes a job.
 */
export async function settleRunsOn(d: DomainPort) {
  const pending = await d.pendingRunsOn()
  for (const p of pending) {
    let text: string | null = null
    try {
      const bytes = await d.svc.git.blob(`${p.owner}/${p.name}`, p.file, p.sha)
      text = bytes ? new TextDecoder().decode(bytes) : null
    } catch {
      text = null
    }
    const read = text === null ? null : runsOnOf(text)
    await d.setRunsOn(
      p.owner,
      p.name,
      p.number,
      read
        ? { jobs: Object.fromEntries(read.jobs), warnings: read.warnings }
        : null,
    )
  }
}

/** Puts what was read on a pending run's jobs. Shared by both domains. */
export function applyRunsOn(
  r: {
    runsOnPending?: boolean
    runsOnFrom?: number
    file: string
    sha: string
    jobs: Array<{ name: string; runsOn?: Array<string> }>
    annotations: Array<{
      level: 'error' | 'warn'
      text: string
      job: string
      step: string
    }>
  },
  read: { jobs: Record<string, Array<string>>; warnings: Array<string> } | null,
) {
  if (read) {
    for (const j of r.jobs) j.runsOn = read.jobs[j.name] ?? []
    for (const w of read.warnings)
      r.annotations.push({ level: 'warn', text: w, job: '', step: '' })
  } else if (r.jobs.some((j) => j.runsOn?.length))
    r.annotations.push({
      level: 'warn',
      text: `${r.file} could not be read at ${r.sha.slice(0, 7)}, so runs-on was copied from run #${r.runsOnFrom ?? '?'}.`,
      job: '',
      step: '',
    })
  r.runsOnPending = false
}
