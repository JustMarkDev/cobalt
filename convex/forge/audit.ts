import { v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import { AUDIT_KEEP_MS, hasBusiness } from '@cobaltforge/api/plans'
import { internal } from '../_generated/api'
import { internalMutation, query } from '../_generated/server'
import { signedIn } from '../lib/actor'
import { accountByHandle, roleIn } from '../lib/access'
import { fail } from '../lib/errors'
import { planOf } from '../lib/plan'
import type { QueryCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'

// Owners and admins of an organization on Business read its audit log.
export async function auditReader(
  ctx: QueryCtx,
  p: Actor,
  handle: string,
  now: number,
) {
  const org = await accountByHandle(ctx, handle)
  if (!org || org.kind !== 'organization')
    fail('not_found', `No organization ${handle}.`)
  const role = await roleIn(ctx, org, p.handle)
  if (!role) fail('not_found', `No organization ${handle}.`)
  if (role === 'member')
    fail('forbidden', 'Only owners and admins read the audit log.')
  if (!hasBusiness((await planOf(ctx, org._id, now)).plan))
    fail(
      'plan_required',
      `${handle} is not on Business, which keeps an audit log you can read.`,
      { hint: 'Move the organization to Business. See /pricing.' },
    )
  return org
}

export const list = query({
  args: {
    org: v.string(),
    at: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        id: v.string(),
        at: v.number(),
        actor: v.string(),
        via: v.union(v.string(), v.null()),
        action: v.string(),
        target: v.string(),
        detail: v.union(v.string(), v.null()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal('SplitRecommended'),
        v.literal('SplitRequired'),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, a) => {
    const org = await auditReader(ctx, await signedIn(ctx), a.org, a.at)
    const res = await ctx.db
      .query('auditEvents')
      .withIndex('by_organizationId_and_at', (q) =>
        q.eq('organizationId', org._id).gte('at', a.at - AUDIT_KEEP_MS),
      )
      .order('desc')
      .paginate(a.paginationOpts)
    return {
      ...res,
      page: res.page.map((e) => ({
        id: e._id,
        at: e.at,
        actor: e.actor,
        via: e.via ?? null,
        action: e.action,
        target: e.target,
        detail: e.detail ?? null,
      })),
    }
  },
})

// Events older than a year go, a batch at a time.
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query('auditEvents')
      .withIndex('by_at', (q) => q.lt('at', Date.now() - AUDIT_KEEP_MS))
      .take(500)
    for (const e of old) await ctx.db.delete('auditEvents', e._id)
    if (old.length === 500)
      await ctx.scheduler.runAfter(0, internal.forge.audit.sweep, {})
    return null
  },
})
