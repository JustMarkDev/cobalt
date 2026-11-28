import { v } from 'convex/values'
import {
  GRANT_MAX_MS,
  LAPSED_KEEP_MS,
  limitsFor,
  overQuota,
} from '@cobaltforge/api/plans'
import { internalMutation, internalQuery, query } from './_generated/server'
import { signedIn } from './lib/actor'
import { fail, out } from './lib/errors'
import { accountByHandle, roleIn } from './lib/access'
import { planOf, seatsOf } from './lib/plan'
import { usageOf } from './lib/usage'
import { audit } from './lib/audit'

const paid = v.union(
  v.literal('solo'),
  v.literal('team'),
  v.literal('business'),
)

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
    const seats = await seatsOf(ctx, account._id, effective)
    return out({
      handle: account.handle,
      usage: {
        ...usage,
        quota: effective.unlimited ? null : overQuota(effective.plan, usage),
      },
      plan: effective.plan,
      source: effective.source,
      until: effective.until,
      unlimited: effective.unlimited,
      seats,
      limits: effective.unlimited ? null : limitsFor(effective.plan, seats),
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

// An organization's plan, as its owners and admins see it on its settings.
export const ofOrganization = query({
  args: { handle: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const org = await accountByHandle(ctx, a.handle)
    if (!org || org.kind !== 'organization')
      fail('not_found', `No organization ${a.handle}.`)
    const role = await roleIn(ctx, org, p.handle)
    if (!role) fail('not_found', `No organization ${a.handle}.`)
    const now = Date.now()
    const effective = await planOf(ctx, org._id, now)
    const usage = await usageOf(ctx, org._id, now)
    const seats = await seatsOf(ctx, org._id, effective)
    const members = (
      await ctx.db
        .query('memberships')
        .withIndex('by_organizationId_and_personId', (q) =>
          q.eq('organizationId', org._id),
        )
        .take(1000)
    ).length
    return out({
      handle: org.handle,
      manage: role === 'owner',
      plan: effective.plan,
      source: effective.source,
      until: effective.until,
      unlimited: effective.unlimited,
      seats,
      members,
      limits: effective.unlimited ? null : limitsFor(effective.plan, seats),
      usage,
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

export const grant = internalMutation({
  args: {
    handle: v.string(),
    plan: paid,
    days: v.optional(v.number()),
    standing: v.optional(v.boolean()),
    reason: v.string(),
    by: v.optional(v.string()),
  },
  handler: async (ctx, { handle, plan, days, standing, reason, by }) => {
    const account = await accountOf(ctx, handle)
    if (!reason.trim()) fail('invalid_request', 'Say why in `reason`.')
    const now = Date.now()
    if (standing) {
      if (days !== undefined)
        fail('invalid_request', 'A standing grant has no `days`.')
      await ctx.db.insert('planGrants', {
        accountId: account._id,
        plan,
        reason: reason.trim(),
        grantedBy: by ?? 'operator',
        created: now,
      })
      return { handle, plan, expires: null }
    }
    const length = (days ?? 0) * 86_400_000
    if (!(days !== undefined && days >= 1) || length > GRANT_MAX_MS)
      fail('invalid_request', 'A grant lasts between 1 and 366 days.')
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
      if (g.revoked || (g.expires !== undefined && g.expires <= now)) continue
      await ctx.db.patch('planGrants', g._id, { revoked: now })
      revoked++
    }
    return { handle, revoked }
  },
})

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
      expires:
        g.expires === undefined ? null : new Date(g.expires).toISOString(),
      live: !g.revoked && (g.expires === undefined || g.expires > now),
    }))
  },
})

export const setSubscription = internalMutation({
  args: {
    handle: v.string(),
    plan: paid,
    status: v.union(v.literal('active'), v.literal('lapsed')),
    seats: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    provider: v.optional(v.string()),
    providerRef: v.optional(v.string()),
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
    if (!row || row.plan !== a.plan || row.status !== a.status)
      await audit(
        ctx,
        account,
        { handle: 'cobalt' },
        'plan.changed',
        account.handle,
        {
          plan: a.plan,
          status: a.status,
          ...(a.seats === undefined ? {} : { seats: a.seats }),
        },
      )
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
