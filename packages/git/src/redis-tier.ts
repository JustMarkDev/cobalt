import type { SharedTier } from './cached'

/** The part of Bun's `RedisClient` the tier uses, so a test can stand in for it. */
export interface RedisLike {
  get: (key: string) => Promise<string | null>
  set: (
    key: string,
    value: string,
    ex: 'EX',
    seconds: number,
  ) => Promise<unknown>
}

export type RedisTierOptions = {
  prefix?: string
  /** How long an entry lives. Content never changes; this only bounds memory. */
  ttlSeconds?: number
  /** A call slower than this counts as a failure, so the tier never holds up a read. */
  timeoutMs?: number
  /** After a failure the tier is skipped for this long. */
  coolOffMs?: number
  now?: () => number
}

/**
 * Keeps commit-addressed reads in Redis so every server process shares them.
 * It is a cache, not a store: a slow, unreachable or full Redis costs a read
 * from code.storage, never a failed request.
 */
export function redisTier(
  client: RedisLike,
  o: RedisTierOptions = {},
): SharedTier {
  const prefix = o.prefix ?? 'cb:git:v1:'
  const ttl = o.ttlSeconds ?? 30 * 86_400
  const timeoutMs = o.timeoutMs ?? 150
  const coolOffMs = o.coolOffMs ?? 10_000
  const now = o.now ?? Date.now
  let skipUntil = 0

  async function guarded<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    if (now() < skipUntil) return fallback
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        }),
      ])
    } catch {
      skipUntil = now() + coolOffMs
      return fallback
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get: (key) => guarded(() => client.get(prefix + key), null),
    async set(key, value) {
      await guarded(() => client.set(prefix + key, value, 'EX', ttl), null)
    },
  }
}

/** A tier from `GIT_CACHE_REDIS_URL`, or none when it is not set. */
export function sharedTierFromEnv(
  env: Record<string, string | undefined> = process.env,
  open: (url: string) => RedisLike = (url) =>
    new (
      globalThis as unknown as {
        Bun: { RedisClient: new (url: string) => RedisLike }
      }
    ).Bun.RedisClient(url),
): SharedTier | undefined {
  const url = env.GIT_CACHE_REDIS_URL
  if (!url) return undefined
  try {
    return redisTier(open(url))
  } catch {
    return undefined
  }
}
