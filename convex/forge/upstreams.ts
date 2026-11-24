import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'

type Mirror = {
  state: 'in-sync' | 'syncing' | 'behind' | 'failing'
  lastSync: number
  detail: string | null
  host: string
}

/**
 * Code Storage says how a sync of a linked repository went. The mirror of the
 * repository shows it. Deliveries can arrive out of order, so an older event
 * never overwrites what a later one said.
 */
export const recordSync = internalMutation({
  args: {
    storeId: v.string(),
    event: v.union(
      v.literal('started'),
      v.literal('succeeded'),
      v.literal('failed'),
    ),
    at: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo) return 'unknown_repository'
    const doc = await ctx.db
      .query('repoExtras')
      .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
      .unique()
    if (!doc) return 'no_mirror'
    const extras = JSON.parse(doc.json) as { mirrors: Array<Mirror> }
    const m = extras.mirrors.find((x) => x.host === 'github')
    if (!m) return 'no_mirror'
    if (a.event === 'started') {
      if (a.at < m.lastSync) return 'stale'
      m.state = 'syncing'
      m.detail = null
    } else if (a.event === 'succeeded') {
      m.state = 'in-sync'
      m.lastSync = Math.max(m.lastSync, a.at)
      m.detail = null
    } else {
      if (a.at < m.lastSync) return 'stale'
      m.state = 'failing'
      m.detail = (a.error ?? 'The sync failed.').slice(0, 500)
    }
    await ctx.db.patch('repoExtras', doc._id, {
      json: JSON.stringify(extras),
      version: doc.version + 1,
    })
    return 'recorded'
  },
})
