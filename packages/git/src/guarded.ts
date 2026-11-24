import type { GitRepo } from './index'

const READS = new Set([
  'listFiles',
  'getFileStream',
  'listCommits',
  'getCommit',
  'getCommitDiff',
])
const MAX_RETRIES = 3

function waitFor(e: unknown, attempt: number) {
  const h = (e as { headers?: Headers | Record<string, string> }).headers
  const raw = h instanceof Headers ? h.get('retry-after') : h?.['retry-after']
  const secs = raw ? Number(raw) : Number.NaN
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000)
  return Math.min(250 * 2 ** attempt, 5_000)
}

export function guarded(
  repo: GitRepo,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): GitRepo {
  return new Proxy(repo, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof value !== 'function' || typeof key !== 'string') return value
      return async (...args: Array<unknown>) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await (
              value as (...a: Array<unknown>) => Promise<unknown>
            ).apply(target, args)
          } catch (e) {
            const status = (e as { status?: number }).status
            if (status !== 429) throw e
            if (!READS.has(key) || attempt >= MAX_RETRIES) throw e
            await sleep(waitFor(e, attempt))
          }
        }
      }
    },
  })
}
