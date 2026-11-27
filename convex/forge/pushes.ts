import { v } from 'convex/values'
import { tally } from '../lib/stats'
import { internalMutation } from '../_generated/server'
import { markStale } from '../lib/usage'
import { emit } from '../lib/events'
import { branchOwner, hydrate, saveChange } from '../lib/changes'
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

export const recordPush = internalMutation({
  args: {
    storeId: v.string(),
    ref: v.string(),
    before: v.string(),
    after: v.string(),
    pushedAt: v.number(),
    message: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, { message, ...a }) => {
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
            files: prev.files,
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
            STORAGE_ACTOR,
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
      STORAGE_ACTOR,
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
  },
})
