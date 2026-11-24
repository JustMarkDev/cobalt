import { apiError } from '../problem'
import type { Begin, IdempotencyStore, StoredResponse } from '../idempotency'
import type { Grant, LimitStore, Policy } from '../limiter'

export type ConvexCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>

export function convexCaller(url: string): ConvexCall {
  let client: Promise<{
    mutation: (ref: never, args: Record<string, unknown>) => Promise<unknown>
  }> | null = null
  return async (name, args) => {
    client ??= (async () => {
      const [{ ConvexHttpClient }, { makeFunctionReference }] =
        await Promise.all([import('convex/browser'), import('convex/server')])
      const http = new ConvexHttpClient(url)
      return {
        mutation: (ref: never, a: Record<string, unknown>) =>
          http.mutation(
            makeFunctionReference<'mutation'>(ref as string) as never,
            a as never,
          ),
      }
    })()
    return (await client).mutation(name as never, args)
  }
}

const refused = (e: unknown) =>
  e instanceof Error && /not allowed/.test(e.message)

export class ConvexLimitStore implements LimitStore {
  private readonly fallback = new Map<string, { start: number; used: number }>()
  constructor(
    private readonly call: ConvexCall,
    private readonly secret: string,
  ) {}

  async take(
    key: string,
    want: number,
    policy: Policy,
    now = Date.now(),
  ): Promise<Grant> {
    try {
      return (await this.call('apiStores:takeLimit', {
        secret: this.secret,
        key,
        want,
        limit: policy.limit,
        windowMs: policy.windowMs,
      })) as Grant
    } catch (e) {
      if (refused(e)) throw e
      const start = now - (now % policy.windowMs)
      let block = this.fallback.get(key)
      if (!block || block.start !== start) {
        block = { start, used: 0 }
        this.fallback.set(key, block)
      }
      const allowance = Math.max(1, Math.floor(policy.limit * 0.01))
      const granted = Math.max(0, Math.min(want, allowance - block.used))
      block.used += granted
      if (this.fallback.size > 10_000) {
        for (const [k, b] of this.fallback)
          if (b.start !== start) this.fallback.delete(k)
        while (this.fallback.size > 10_000)
          this.fallback.delete(this.fallback.keys().next().value as string)
      }
      console.error('rate limit store unavailable, admitting a small block', e)
      return {
        granted,
        remaining: 0,
        resetMs: Math.min(policy.windowMs, 5_000),
      }
    }
  }
}

export class ConvexIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly call: ConvexCall,
    private readonly secret: string,
    private readonly ttlMs = 24 * 3_600_000,
  ) {}

  private async guarded<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    try {
      return (await this.call(name, { secret: this.secret, ...args })) as T
    } catch (e) {
      if (refused(e))
        throw apiError(
          'internal',
          'The API is misconfigured: the shared store refused its secret.',
        )
      console.error('idempotency store unavailable', e)
      throw apiError(
        'backend_unavailable',
        'The store that makes repeated writes safe is not reachable.',
      )
    }
  }

  async begin(scope: string, key: string, fingerprint: string): Promise<Begin> {
    const r = await this.guarded<
      | { state: 'new'; lease: string }
      | { state: 'conflict' | 'in_progress' }
      | {
          state: 'replay'
          response: { status: number; headers: string; body: string }
        }
    >('apiStores:beginIdempotency', {
      scope,
      key,
      fingerprint,
      ttlMs: this.ttlMs,
    })
    if (r.state !== 'replay') return r
    return {
      state: 'replay',
      response: {
        status: r.response.status,
        headers: JSON.parse(r.response.headers) as Record<string, string>,
        body: r.response.body,
      },
    }
  }

  async complete(
    scope: string,
    key: string,
    lease: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.guarded('apiStores:completeIdempotency', {
      scope,
      key,
      lease,
      status: response.status,
      headers: JSON.stringify(response.headers),
      body: response.body,
    })
  }

  async abort(scope: string, key: string, lease: string): Promise<void> {
    await this.guarded('apiStores:abortIdempotency', { scope, key, lease })
  }
}
