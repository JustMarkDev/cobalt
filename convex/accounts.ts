import { v } from 'convex/values'
import { internalQuery } from './_generated/server'
import { retiredHash } from './deletion'

export const handleHolder = internalQuery({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const account = await ctx.db
      .query('accounts')
      .withIndex('by_handle', (q) => q.eq('handle', handle))
      .unique()
    if (account)
      return {
        kind: account.kind,
        authId: account.authId ?? null,
        alias: false,
      }
    const retired = await ctx.db
      .query('retiredHandles')
      .withIndex('by_hash', (q) => q.eq('hash', retiredHash(handle)))
      .unique()
    if (retired)
      return { kind: 'person' as const, authId: 'retired', alias: false }
    const alias = await ctx.db
      .query('handleAliases')
      .withIndex('by_handle', (q) => q.eq('handle', handle))
      .unique()
    if (!alias) return null
    const target = await ctx.db.get('accounts', alias.accountId)
    return target
      ? { kind: target.kind, authId: target.authId ?? null, alias: true }
      : null
  },
})
