import { v } from 'convex/values'
import {
  GRANT_MAX_MS,
  LAPSED_KEEP_MS,
  overQuota,
  planLimits,
} from '@source-code/api/plans'
import { internalMutation, internalQuery, query } from './_generated/server'
import { signedIn } from './lib/actor'
import { fail, out } from './lib/errors'
import { accountByHandle } from './lib/access'
import { planOf } from './lib/plan'
import { usageOf } from './lib/usage'

/**
 * Plans: what an account is on, and the operator's tools to change it.
 *
 * The signed-in person reads their own plan with `mine`. A plan is changed
 * only from the command line, with an internal function, never by an API call:
 *
 *   bunx convex run plans:grant '{"handle":"theo","plan":"business","days":60,"reason":"Trying it"}'
 *   bunx convex run plans:revokeGrants '{"handle":"theo"}'
 *   bunx convex run plans:grants '{"handle":"theo"}'
 *
 * Polar calls `setSubscription` from its webhook (`http.ts`, `/hooks/polar`,
 * `@source-code/api/polar`): the checkout carries the paying address and the
 * plan in its metadata (`account`, `plan`).
 */

const paid = v.union(
  v.literal('solo'),
  v.literal('team'),
  v.literal('business'),
)

/** The plan of the signed-in person's own account, and any deletion waiting. */
export const mine = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const p = await signedIn(ctx)
    const account = await accountByHandle(ctx, p.handle)
    if (!account) fail('not_found', `No account ${p.handle}.`)
    const now = Date.now()
    const effective = await planOf(ctx, account._id, now)
    const usage = await usageOf(ctx, account._id, now)
    return out({
      handle: account.handle,
      usage: { ...usage, quota: overQuota(effective.plan, usage) },
      plan: effective.plan,
      source: effective.source,
      until: effective.until,
      limits: planLimits[effective.plan],
      // After a subscription ended, history is kept until this moment.
      keptUntil:
        effective.lapsedAt === null
          ? null
          : effective.lapsedAt + LAPSED_KEEP_MS,
      deletion:
        account.purgeAt === undefined
          ? null
          : {
              requested: account.deletionRequested ?? null,
              purgeAt: account.purgeAt,
            },
    })
  },
})

async function accountOf(
  ctx: Parameters<typeof accountByHandle>[0],
  handle: string,
) {
  const account = await accountByHandle(ctx, handle)
  if (!account) fail('not_found', `No account ${handle}.`)
  return account
}

/** Gives one account a paid plan for a while. It always ends. */
export const grant = internalMutation({
  args: {
    handle: v.string(),
    plan: paid,
    days: v.number(),
    reason: v.string(),
    by: v.optional(v.string()),
  },
  handler: async (ctx, { handle, plan, days, reason, by }) => {
    const account = await accountOf(ctx, handle)
    const length = days * 86_400_000
    if (!(days >= 1) || length > GRANT_MAX_MS)
      fail('invalid_request', 'A grant lasts between 1 and 366 days.')
    if (!reason.trim()) fail('invalid_request', 'Say why in `reason`.')
    const now = Date.now()
    const expires = now + length
    await ctx.db.insert('planGrants', {
      accountId: account._id,
      plan,
      reason: reason.trim(),
      grantedBy: by ?? 'operator',
      created: now,
      expires,
    })
    return { handle, plan, expires: new Date(expires).toISOString() }
  },
})

/** Ends every live grant of an account now. */
export const revokeGrants = internalMutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const account = await accountOf(ctx, handle)
    const now = Date.now()
    let revoked = 0
    for (const g of await ctx.db
      .query('planGrants')
      .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
      .take(50)) {
      if (g.revoked || g.expires <= now) continue
      await ctx.db.patch('planGrants', g._id, { revoked: now })
      revoked++
    }
    return { handle, revoked }
  },
})

/** Every grant an account ever had, newest first. */
export const grants = internalQuery({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const account = await accountOf(ctx, handle)
    const now = Date.now()
    return (
      await ctx.db
        .query('planGrants')
        .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
        .order('desc')
        .take(50)
    ).map((g) => ({
      plan: g.plan,
      reason: g.reason,
      grantedBy: g.grantedBy,
      created: new Date(g.created).toISOString(),
      expires: new Date(g.expires).toISOString(),
      live: !g.revoked && g.expires > now,
    }))
  },
})

/**
 * Sets the paid subscription of an account: what the payment provider's
 * webhook will do. `status: 'lapsed'` marks the moment it ended, from which
 * history is kept for 90 days.
 */
export const setSubscription = internalMutation({
  args: {
    handle: v.string(),
    plan: paid,
    status: v.union(v.literal('active'), v.literal('lapsed')),
    seats: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    provider: v.optional(v.string()),
    providerRef: v.optional(v.string()),
    // When the provider says this happened: an older event never undoes a newer one.
    at: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const account = await accountOf(ctx, a.handle)
    const now = Date.now()
    const row = await ctx.db
      .query('subscriptions')
      .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
      .unique()
    if (
      row &&
      a.at !== undefined &&
      row.eventAt !== undefined &&
      a.at < row.eventAt
    )
      return { handle: a.handle, plan: row.plan, status: row.status }
    const next = {
      plan: a.plan,
      status: a.status,
      seats: a.seats,
      periodEnd: a.periodEnd,
      provider: a.provider,
      providerRef: a.providerRef,
      lapsedAt: a.status === 'lapsed' ? (row?.lapsedAt ?? now) : undefined,
      eventAt: a.at,
      updated: now,
    }
    if (row)
      await ctx.db.replace('subscriptions', row._id, {
        accountId: account._id,
        ...next,
      })
    else
      await ctx.db.insert('subscriptions', { accountId: account._id, ...next })
    return { handle: a.handle, plan: a.plan, status: a.status }
  },
})
