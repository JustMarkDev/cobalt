import { mutation as plainMutation } from '../_generated/server'
import { ConvexError } from 'convex/values'
import { claim, fromApi } from './actor'
import { heldBy } from './idempotency'
import type { MutationCtx } from '../_generated/server'

export const mutation = ((definition: {
  handler: (ctx: MutationCtx, args: unknown) => unknown
}) =>
  plainMutation({
    ...definition,
    handler: async (ctx: MutationCtx, args: unknown) => {
      const value = await definition.handler(ctx, args)
      await markEffect(ctx)
      return value
    },
  } as never)) as unknown as typeof plainMutation

async function markEffect(ctx: MutationCtx) {
  const id = await ctx.auth.getUserIdentity()
  const held = id?.[claim.idempotency]
  if (typeof held !== 'string' || !id || !fromApi(id)) return
  let scope: unknown
  let key: unknown
  let lease: unknown
  try {
    ;[scope, key, lease] = JSON.parse(held) as Array<unknown>
  } catch {
    return
  }
  if (typeof scope !== 'string' || typeof key !== 'string') return
  if (lease !== undefined && typeof lease !== 'string') return
  const row = await ctx.db
    .query('apiIdempotency')
    .withIndex('by_scope_and_key', (q) => q.eq('scope', scope).eq('key', key))
    .unique()
  if (!row) return
  if (!heldBy(row, lease))
    throw new ConvexError({
      code: 'request_in_progress',
      detail: 'Another request now holds this Idempotency-Key.',
    })
  if (row.effect === undefined && !row.response)
    await ctx.db.patch('apiIdempotency', row._id, { effect: Date.now() })
}
