export const OFFLINE_AFTER_MS = 90_000
export const LEASE_MS = 15 * 60_000
export const MAX_LABELS = 50
export const MAX_RUNNERS = 100
export const MAX_CONCURRENCY = 64

export const labelShape = /^[a-z0-9][a-z0-9._:+-]{0,49}$/

export function normalizeLabels(labels: ReadonlyArray<string>) {
  return [...new Set(labels.map((l) => l.trim().toLowerCase()))].filter(Boolean)
}

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
  repos: ReadonlyArray<string> | null
  concurrency: number
  disabled: boolean
  lastSeen: number | null
}

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

export const holds = (status: string) =>
  status === 'running' || status === 'waiting'
