import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { mutation } from '../lib/functions'
import { system } from '../lib/actor'
import { out } from '../lib/errors'
import type { MutationCtx } from '../_generated/server'

/** Operations over for more than a week, a batch at a time. */
async function sweepOld(ctx: MutationCtx) {
  const cutoff = Date.now() - 7 * 86_400_000
  for (const o of await ctx.db
    .query('operations')
    .withIndex('by_finished', (q) => q.gt('finished', 0).lt('finished', cutoff))
    .take(500))
    await ctx.db.delete('operations', o._id)
}

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await sweepOld(ctx)
    return null
  },
})

/** The same, now, for the API server's housekeeping call. */
export const sweepNow = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await system(ctx)
    await sweepOld(ctx)
    return out(null)
  },
})
