export type Policy = { readonly limit: number; readonly windowMs: number }

export type Grant = {
  granted: number
  remaining: number
  resetMs: number
}

export interface LimitStore {
  take: (
    key: string,
    want: number,
    policy: Policy,
    now: number,
  ) => Promise<Grant>
}

export class MemoryLimitStore implements LimitStore {
  private readonly windows = new Map<string, { start: number; used: number }>()

  take(key: string, want: number, policy: Policy, now: number) {
    const start = now - (now % policy.windowMs)
    let w = this.windows.get(key)
    if (!w || w.start !== start) {
      w = { start, used: 0 }
      this.windows.set(key, w)
    }
    const granted = Math.max(0, Math.min(want, policy.limit - w.used))
    w.used += granted
    return Promise.resolve({
      granted,
      remaining: policy.limit - w.used,
      resetMs: start + policy.windowMs - now,
    })
  }

  sweep(now: number) {
    for (const [key, w] of this.windows)
      if (w.start + 3_600_000 < now) this.windows.delete(key)
  }
}

export type Decision = {
  allowed: boolean
  limit: number
  remaining: number
  resetSeconds: number
}

type Lease = {
  start: number
  left: number
  storeRemaining: number
  exhausted: boolean
  resetMs: number
}

export class Limiter {
  private readonly leases = new Map<string, Lease>()

  constructor(
    private readonly store: LimitStore,
    private readonly options: {
      leaseShare?: number
      maxLease?: number
      now?: () => number
    } = {},
  ) {}

  private now() {
    return (this.options.now ?? Date.now)()
  }

  tryLocal(key: string, policy: Policy, cost: number): Decision | null {
    const lease = this.leases.get(`${key}@${policy.windowMs}`)
    if (!lease || lease.left < cost) return null
    const now = this.now()
    const start = now - (now % policy.windowMs)
    if (lease.start !== start) return null
    lease.left -= cost
    return {
      allowed: true,
      limit: policy.limit,
      remaining: lease.left + lease.storeRemaining,
      resetSeconds: Math.ceil((start + policy.windowMs - now) / 1000),
    }
  }

  async check(key: string, policy: Policy, cost: number): Promise<Decision> {
    const now = this.now()
    const start = now - (now % policy.windowMs)
    const id = `${key}@${policy.windowMs}`
    let lease = this.leases.get(id)
    if (!lease || lease.start !== start) {
      lease = {
        start,
        left: 0,
        storeRemaining: policy.limit,
        exhausted: false,
        resetMs: 0,
      }
      this.leases.set(id, lease)
    }
    const resetSeconds = Math.ceil((start + policy.windowMs - now) / 1000)
    if (cost === 0)
      return {
        allowed: true,
        limit: policy.limit,
        remaining: lease.left + lease.storeRemaining,
        resetSeconds,
      }
    if (lease.left < cost && lease.exhausted)
      return {
        allowed: false,
        limit: policy.limit,
        remaining: 0,
        resetSeconds,
      }
    if (lease.left < cost) {
      const share = this.options.leaseShare ?? 0.05
      const size = Math.max(
        cost,
        Math.min(this.options.maxLease ?? 50, Math.ceil(policy.limit * share)),
      )
      const g = await this.store.take(`${key}@${start}`, size, policy, now)
      lease.left += g.granted
      lease.storeRemaining = g.remaining
      if (lease.left < cost) {
        if (g.granted === 0) lease.exhausted = true
        return {
          allowed: false,
          limit: policy.limit,
          remaining: lease.left,
          resetSeconds: Math.max(1, Math.ceil(g.resetMs / 1000)),
        }
      }
    }
    lease.left -= cost
    return {
      allowed: true,
      limit: policy.limit,
      remaining: lease.left + lease.storeRemaining,
      resetSeconds,
    }
  }

  refund(key: string, policy: Policy, cost: number) {
    const lease = this.leases.get(`${key}@${policy.windowMs}`)
    const now = this.now()
    if (lease && lease.start === now - (now % policy.windowMs))
      lease.left += cost
  }

  sweep() {
    const now = this.now()
    for (const [id, lease] of this.leases)
      if (lease.start + 3_600_000 < now) this.leases.delete(id)
  }
}

export class Concurrency {
  private readonly active = new Map<string, number>()
  constructor(private readonly max: number) {}

  enter(key: string): boolean {
    const n = this.active.get(key) ?? 0
    if (n >= this.max) return false
    this.active.set(key, n + 1)
    return true
  }

  leave(key: string) {
    const n = (this.active.get(key) ?? 1) - 1
    if (n <= 0) this.active.delete(key)
    else this.active.set(key, n)
  }
}

export const pools = {
  read: { limit: 1200, windowMs: 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  heavy: { limit: 120, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  anonymous: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, Policy>

export type PoolName = keyof typeof pools
