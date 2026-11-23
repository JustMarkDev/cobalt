/**
 * Runners: machines (yours, or a provider's) that registered with the forge,
 * with labels, the repositories they may serve and how many jobs they take at
 * once. The forge stores the record and routes jobs to it; the machine runs
 * them. Plain JavaScript: the memory domain and the Convex functions route
 * the same way.
 */

/** A runner that has not sent a heartbeat for this long is offline. */
export const OFFLINE_AFTER_MS = 90_000
/** How long a claimed job stays with its runner without a report or heartbeat. */
export const LEASE_MS = 15 * 60_000
export const MAX_LABELS = 50
export const MAX_RUNNERS = 100
export const MAX_CONCURRENCY = 64

export const labelShape = /^[a-z0-9][a-z0-9._:+-]{0,49}$/

/** Lowercase, trimmed, each once, in the order given. */
export function normalizeLabels(labels: ReadonlyArray<string>) {
  return [...new Set(labels.map((l) => l.trim().toLowerCase()))].filter(Boolean)
}

/** A job runs on a runner when every label it asks for is one the runner has. Case does not matter. */
export function labelsMatch(
  wanted: ReadonlyArray<string>,
  has: ReadonlyArray<string>,
) {
  const set = new Set(has.map((l) => l.toLowerCase()))
  return wanted.every((l) => set.has(l.toLowerCase()))
}

export type RunnerLike = {
  account: string
  labels: ReadonlyArray<string>
  /** Lowercase `owner/name`, or null for every repository of the account. */
  repos: ReadonlyArray<string> | null
  concurrency: number
  disabled: boolean
  lastSeen: number | null
}

/** Whether a runner may take work from a repository: its account's, and on its list if it has one. */
export function mayServe(r: RunnerLike, owner: string, name: string) {
  if (owner.toLowerCase() !== r.account.toLowerCase()) return false
  return !r.repos || r.repos.includes(`${owner}/${name}`.toLowerCase())
}

export function runnerStatus(r: RunnerLike, current: number, now: number) {
  if (r.disabled) return 'disabled' as const
  if (r.lastSeen === null || now - r.lastSeen > OFFLINE_AFTER_MS)
    return 'offline' as const
  if (current >= r.concurrency) return 'busy' as const
  return 'online' as const
}

/**
 * For a queued job: the labels it waits for when no runner that may serve
 * the repository has them all. Null when one has (online or not), or when
 * the job asks for nothing.
 */
export function waitingForLabels(
  runsOn: ReadonlyArray<string>,
  runners: ReadonlyArray<RunnerLike>,
  owner: string,
  name: string,
) {
  if (!runsOn.length) return null
  const ok = runners.some(
    (r) =>
      !r.disabled && mayServe(r, owner, name) && labelsMatch(runsOn, r.labels),
  )
  return ok ? null : [...runsOn]
}

/** A job a runner holds: running, or waiting on someone. */
export const holds = (status: string) =>
  status === 'running' || status === 'waiting'
