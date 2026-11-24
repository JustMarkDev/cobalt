import { v } from 'convex/values'
import { internal } from './_generated/api'
import { env, internalMutation, mutation } from './_generated/server'
import { heldBy } from './lib/idempotency'
import type { MutationCtx } from './_generated/server'

const stateValidator = v.union(
  v.object({ state: v.literal('new'), lease: v.string() }),
  v.object({ state: v.literal('conflict') }),
  v.object({ state: v.literal('in_progress') }),
  v.object({
    state: v.literal('replay'),
    response: v.object({
      status: v.number(),
      headers: v.string(),
      body: v.string(),
    }),
  }),
)

export function assertSecret(secret: string) {
  const want = env.API_STORE_SECRET
  let diff = want === undefined || want.length < 16 ? 1 : 0
  const a = want ?? ''
  const n = Math.max(a.length, secret.length)
  diff |= a.length ^ secret.length
  for (let i = 0; i < n; i++)
    diff |= (a.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0)
  if (diff !== 0) throw new Error('not allowed')
}

export const takeLimit = mutation({
  args: {
    secret: v.string(),
    key: v.string(),
    want: v.number(),
    limit: v.number(),
    windowMs: v.number(),
  },
  returns: v.object({
    granted: v.number(),
    remaining: v.number(),
    resetMs: v.number(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.secret)
    return await take(ctx, args)
  },
})

export const takeAuthLimit = internalMutation({
  args: { key: v.string(), limit: v.number(), windowMs: v.number() },
  returns: v.object({
    granted: v.number(),
    remaining: v.number(),
    resetMs: v.number(),
  }),
  handler: async (ctx, args) => await take(ctx, { ...args, want: 1 }),
})

async function take(
  ctx: MutationCtx,
  args: { key: string; want: number; limit: number; windowMs: number },
) {
  if (args.windowMs <= 0 || args.want < 0 || args.limit < 0)
    throw new Error('bad policy')
  const now = Date.now()
  const start = now - (now % args.windowMs)
  const row = await ctx.db
    .query('apiLimits')
    .withIndex('by_key', (q) => q.eq('key', args.key))
    .unique()
  const used = row && row.start === start ? row.used : 0
  const granted = Math.max(0, Math.min(args.want, args.limit - used))
  if (!row)
    await ctx.db.insert('apiLimits', {
      key: args.key,
      start,
      used: used + granted,
    })
  else if (granted > 0 || row.start !== start)
    await ctx.db.patch('apiLimits', row._id, { start, used: used + granted })
  return {
    granted,
    remaining: args.limit - used - granted,
    resetMs: start + args.windowMs - now,
  }
}

const LEASE_MS = 10 * 60_000

const lost = {
  status: 409,
  headers: JSON.stringify({ 'content-type': 'application/problem+json' }),
  body: JSON.stringify({
    type: 'https://cobaltforge.dev/docs/api/errors#request_outcome_unknown',
    title:
      'The first request with this Idempotency-Key changed something, then lost its answer',
    status: 409,
    code: 'request_outcome_unknown',
    detail:
      'The first request with this Idempotency-Key made a change, then stopped before it answered. It will not run again.',
    hint: 'Read the object to see where it stands. Use a new key only for a new request.',
    retryable: false,
    exit_code: 1,
  }),
}

const leaseId = (now: number) =>
  `${now.toString(36)}.${Math.random().toString(36).slice(2, 12)}`

export const beginIdempotency = mutation({
  args: {
    secret: v.string(),
    scope: v.string(),
    key: v.string(),
    fingerprint: v.string(),
    ttlMs: v.number(),
  },
  returns: stateValidator,
  handler: async (ctx, args) => {
    assertSecret(args.secret)
    const now = Date.now()
    const row = await ctx.db
      .query('apiIdempotency')
      .withIndex('by_scope_and_key', (q) =>
        q.eq('scope', args.scope).eq('key', args.key),
      )
      .unique()
    if (row && row.expires > now) {
      if (row.fingerprint !== args.fingerprint)
        return { state: 'conflict' as const }
      if (row.response)
        return { state: 'replay' as const, response: row.response }
      if (now - (row.started ?? now) > LEASE_MS) {
        if (row.effect === undefined) {
          const lease = leaseId(now)
          await ctx.db.patch('apiIdempotency', row._id, { started: now, lease })
          return { state: 'new' as const, lease }
        }
        await ctx.db.patch('apiIdempotency', row._id, { response: lost })
        return { state: 'replay' as const, response: lost }
      }
      return { state: 'in_progress' as const }
    }
    if (row) await ctx.db.delete('apiIdempotency', row._id)
    const lease = leaseId(now)
    await ctx.db.insert('apiIdempotency', {
      scope: args.scope,
      key: args.key,
      fingerprint: args.fingerprint,
      expires: now + args.ttlMs,
      started: now,
      lease,
    })
    return { state: 'new' as const, lease }
  },
})

const MAX_BODY = 900_000

export const completeIdempotency = mutation({
  args: {
    secret: v.string(),
    scope: v.string(),
    key: v.string(),
    lease: v.optional(v.string()),
    status: v.number(),
    headers: v.string(),
    body: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret)
    const row = await ctx.db
      .query('apiIdempotency')
      .withIndex('by_scope_and_key', (q) =>
        q.eq('scope', args.scope).eq('key', args.key),
      )
      .unique()
    if (!heldBy(row, args.lease) || row.response) return null
    const tooBig = args.body.length + args.headers.length > MAX_BODY
    await ctx.db.patch('apiIdempotency', row._id, {
      response: tooBig
        ? {
            status: 500,
            headers: JSON.stringify({
              'content-type': 'application/problem+json',
            }),
            body: JSON.stringify({
              status: 500,
              code: 'internal',
              detail:
                'The first request finished, but its response was too large to keep for replay.',
            }),
          }
        : { status: args.status, headers: args.headers, body: args.body },
    })
    return null
  },
})

export const abortIdempotency = mutation({
  args: {
    secret: v.string(),
    scope: v.string(),
    key: v.string(),
    lease: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret)
    const row = await ctx.db
      .query('apiIdempotency')
      .withIndex('by_scope_and_key', (q) =>
        q.eq('scope', args.scope).eq('key', args.key),
      )
      .unique()
    if (!heldBy(row, args.lease) || row.response) return null
    if (row.effect !== undefined)
      await ctx.db.patch('apiIdempotency', row._id, { response: lost })
    else await ctx.db.delete('apiIdempotency', row._id)
    return null
  },
})

const SWEEP_BATCH = 500

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    const windows = await ctx.db
      .query('apiLimits')
      .withIndex('by_start', (q) => q.lt('start', now - 3_600_000))
      .take(SWEEP_BATCH)
    for (const w of windows) await ctx.db.delete('apiLimits', w._id)
    const keys = await ctx.db
      .query('apiIdempotency')
      .withIndex('by_expires', (q) => q.lt('expires', now))
      .take(SWEEP_BATCH)
    for (const k of keys) await ctx.db.delete('apiIdempotency', k._id)
    if (windows.length === SWEEP_BATCH || keys.length === SWEEP_BATCH)
      await ctx.scheduler.runAfter(0, internal.apiStores.sweep, {})
    return null
  },
})
