import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { assertSecret } from './apiStores'
import type { Id } from './_generated/dataModel'
import { addUsage } from './lib/usage'

const LEASE_MS = 5 * 60_000

export const claim = mutation({
  args: {
    secret: v.string(),
    kinds: v.array(v.union(v.literal('git'), v.literal('blob'))),
    measure: v.boolean(),
    max: v.number(),
  },
  returns: v.object({
    sweeps: v.array(
      v.object({
        id: v.id('sweeps'),
        kind: v.union(v.literal('git'), v.literal('blob')),
        key: v.string(),
      }),
    ),
    measure: v.array(v.string()),
  }),
  handler: async (ctx, a) => {
    assertSecret(a.secret)
    const now = Date.now()
    const max = Math.max(1, Math.min(a.max, 100))
    const sweeps: Array<{
      id: Id<'sweeps'>
      kind: 'git' | 'blob'
      key: string
    }> = []
    for (const kind of a.kinds)
      for (const s of await ctx.db
        .query('sweeps')
        .withIndex('by_kind_and_lease', (q) =>
          q.eq('kind', kind).lt('lease', now),
        )
        .take(max)) {
        if (sweeps.length >= max) break
        await ctx.db.patch('sweeps', s._id, { lease: now + LEASE_MS })
        if (s.kind !== 'provider')
          sweeps.push({ id: s._id, kind: s.kind, key: s.key })
      }
    const measure = a.measure
      ? (
          await ctx.db
            .query('repoSizes')
            .withIndex('by_stale_and_measured', (q) => q.eq('stale', true))
            .take(max)
        ).map((r) => r.storeId)
      : []
    return { sweeps, measure }
  },
})

export const done = mutation({
  args: { secret: v.string(), ids: v.array(v.id('sweeps')) },
  returns: v.null(),
  handler: async (ctx, a) => {
    assertSecret(a.secret)
    for (const id of a.ids.slice(0, 100)) await ctx.db.delete('sweeps', id)
    return null
  },
})

export const reportSize = mutation({
  args: { secret: v.string(), storeId: v.string(), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    assertSecret(a.secret)
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    const row = await ctx.db
      .query('repoSizes')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo) {
      if (row) await ctx.db.delete('repoSizes', row._id)
      return null
    }
    const now = Date.now()
    const bytes = Math.max(0, Math.floor(a.bytes))
    const grew = Math.max(0, bytes - (row?.bytes ?? 0))
    if (row && row.measured > 0 && grew > 0)
      await addUsage(ctx, repo.ownerId, { pushBytes: grew }, now)
    if (row)
      await ctx.db.patch('repoSizes', row._id, {
        bytes,
        measured: now,
        stale: false,
      })
    else
      await ctx.db.insert('repoSizes', {
        repoId: repo._id,
        storeId: repo.storeId,
        bytes,
        measured: now,
        stale: false,
      })
    return null
  },
})

export const addTransfer = mutation({
  args: { secret: v.string(), storeId: v.string(), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    assertSecret(a.secret)
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo || !(a.bytes > 0)) return null
    await addUsage(ctx, repo.ownerId, { transferBytes: Math.floor(a.bytes) })
    return null
  },
})
