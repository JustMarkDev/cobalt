import { v } from 'convex/values'
import { tally } from '../lib/stats'
import { internalMutation } from '../_generated/server'
import type { MutationCtx } from '../_generated/server'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { system } from '../lib/actor'
import { out } from '../lib/errors'
import { markStale } from '../lib/usage'
import { emit } from '../lib/events'
import {
  branchOwner,
  fileStatsValidator,
  filesOfStats,
  hydrate,
  saveChange,
} from '../lib/changes'
import { actorFor } from '../lib/events'
import { pushReceipt } from '@cobaltforge/api/trailers'
import { contributionRefusal } from '@cobaltforge/api/via'

// Pushes to different branches of one repository run at the same time, and
// every row they all write is a place they queue behind each other. The event
// itself has to write the repository's counters, but `repos.updated` is only a
// sort key for "recently active": once in a while is as good as every push.
const TOUCH_EVERY_MS = 30_000

const STORAGE_ACTOR = {
  id: 'acc_codestorage000000',
  handle: 'code.storage',
}

const pushArgs = {
  storeId: v.string(),
  ref: v.string(),
  before: v.string(),
  after: v.string(),
  pushedAt: v.number(),
  message: v.optional(v.string()),
  /** Who pushed, when the push came through cobalt; else Code Storage. */
  by: v.optional(v.string()),
  /** What the pushed branch changes against its change's base, from git. */
  stats: v.optional(fileStatsValidator),
}

type PushArgs = {
  storeId: string
  ref: string
  before: string
  after: string
  pushedAt: number
  message?: string
  by?: string
  stats?: Array<{ path: string; add: number; del: number }>
}

async function record(
  ctx: MutationCtx,
  { message, by, stats, ...a }: PushArgs,
) {
  const seen = await ctx.db
    .query('pushes')
    .withIndex('by_storeId_and_ref_and_after', (q) =>
      q.eq('storeId', a.storeId).eq('ref', a.ref).eq('after', a.after),
    )
    .first()
  if (seen) return 'duplicate'
  await tally(ctx, 'repository.pushed')
  await ctx.db.insert('pushes', a)
  const repo = await ctx.db
    .query('repos')
    .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
    .unique()
  if (!repo) return 'unknown_repository'
  const pusher = by ? await actorFor(ctx, by) : STORAGE_ACTOR
  await markStale(ctx, repo)
  const branch = a.ref.startsWith('refs/heads/')
    ? a.ref.slice('refs/heads/'.length)
    : null
  let result = 'recorded'
  if (branch && branch !== repo.defaultBranch && !/^0+$/.test(a.after)) {
    const doc = await branchOwner(ctx, repo, branch)
    if (doc) {
      const l = await hydrate(ctx, doc)
      const c = l.rec
      const prev = c.patchSets[c.patchSets.length - 1]
      const via = pushReceipt(message)
      const refused = contributionRefusal(
        repo,
        c.author.handle,
        via.model,
        'change',
      )
      const declined = refused !== null
      if (refused) result = refused.code
      if (prev.sha !== a.after && !declined) {
        c.patchSets.push({
          n: prev.n + 1,
          sha: a.after,
          tree: a.after.slice(0, 7),
          note: 'Pushed',
          author: c.author,
          created: a.pushedAt,
          files: stats ? filesOfStats(stats, a.after) : prev.files,
          kind: 'update',
          via,
        })
        for (const r of c.reviews) r.carries = false
        c.updated = Math.max(Date.now(), c.updated + 1)
        c.version++
        await saveChange(ctx, l)
        await emit(
          ctx,
          repo,
          'change.updated',
          pusher,
          { object: 'change', id: c.id, number: c.number },
          ['head.patch_set', 'policy.state', 'checks.state'],
          null,
          ['changeRev'],
        )
        result = 'patch_set_added'
      }
    }
  }
  await emit(
    ctx,
    repo,
    'repository.pushed',
    pusher,
    { object: 'repo', id: repo.publicId, number: null },
    ['refs'],
    {
      ref: a.ref,
      before: a.before,
      after: a.after,
    },
    [],
    a.pushedAt - repo.updated >= TOUCH_EVERY_MS,
  )
  return result
}

/** From Code Storage's webhook. */
export const recordPush = internalMutation({
  args: pushArgs,
  returns: v.string(),
  handler: (ctx, a) => record(ctx, a),
})

/**
 * From the API, for a push that went through it: counted at once instead of
 * when the webhook arrives. The same ref and commit twice count once.
 */
export const recordPushFromApi = mutation({
  args: pushArgs,
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    return out(await record(ctx, a))
  },
})

/** The base of the open change on a branch, so the API can diff a push against it. */
export const baseOfBranch = query({
  args: { storeId: v.string(), branch: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo || a.branch === repo.defaultBranch) return out(null)
    const doc = await branchOwner(ctx, repo, a.branch)
    return out(doc ? (await hydrate(ctx, doc)).rec.base : null)
  },
})
