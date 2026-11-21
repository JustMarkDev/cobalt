import type { Usage } from '@source-code/api/plans'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * What an account has used: the size of the repositories it owns, as the git
 * store last reported it, and what it moved this month. Fed by the store
 * worker (`storeWorker.ts`).
 */
type Ctx = Pick<QueryCtx, 'db'>

/** `2026-11`, in UTC: the month a transfer allowance is counted in. */
export const monthOf = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 7)

export async function usageOf(
  ctx: Ctx,
  accountId: Id<'accounts'>,
  now: number = Date.now(),
): Promise<Usage> {
  const repos = await ctx.db
    .query('repos')
    .withIndex('by_ownerId_and_name', (q) => q.eq('ownerId', accountId))
    .take(500)
  let storageBytes = 0
  for (const r of repos) {
    const size = await ctx.db
      .query('repoSizes')
      .withIndex('by_repoId', (q) => q.eq('repoId', r._id))
      .unique()
    storageBytes += size?.bytes ?? 0
  }
  const month = await ctx.db
    .query('accountUsage')
    .withIndex('by_accountId_and_month', (q) =>
      q.eq('accountId', accountId).eq('month', monthOf(now)),
    )
    .unique()
  return {
    storageBytes,
    transferBytes: month?.transferBytes ?? 0,
    pushBytes: month?.pushBytes ?? 0,
  }
}

/** A push landed: the repository's size is out of date until the worker measures it. */
export async function markStale(ctx: MutationCtx, repo: Doc<'repos'>) {
  const row = await ctx.db
    .query('repoSizes')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
  if (row) {
    if (!row.stale) await ctx.db.patch('repoSizes', row._id, { stale: true })
    return
  }
  await ctx.db.insert('repoSizes', {
    repoId: repo._id,
    storeId: repo.storeId,
    bytes: 0,
    measured: 0,
    stale: true,
  })
}

/** Adds to what an account moved this month. */
export async function addUsage(
  ctx: MutationCtx,
  accountId: Id<'accounts'>,
  add: { transferBytes?: number; pushBytes?: number },
  now: number = Date.now(),
) {
  const month = monthOf(now)
  const row = await ctx.db
    .query('accountUsage')
    .withIndex('by_accountId_and_month', (q) =>
      q.eq('accountId', accountId).eq('month', month),
    )
    .unique()
  if (row)
    await ctx.db.patch('accountUsage', row._id, {
      transferBytes: row.transferBytes + (add.transferBytes ?? 0),
      pushBytes: row.pushBytes + (add.pushBytes ?? 0),
    })
  else
    await ctx.db.insert('accountUsage', {
      accountId,
      month,
      transferBytes: add.transferBytes ?? 0,
      pushBytes: add.pushBytes ?? 0,
    })
}
