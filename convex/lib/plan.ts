import {
  allowsPrivate,
  effectivePlan,
  overQuota,
  repoState,
} from '@cobaltforge/api/plans'
import { fail } from './errors'
import { usageOf } from './usage'
import type { Effective, Quota } from '@cobaltforge/api/plans'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

type Ctx = Pick<QueryCtx, 'db'>

export async function planOf(
  ctx: Ctx,
  accountId: Id<'accounts'>,
  now: number = Date.now(),
): Promise<Effective> {
  const sub = await ctx.db
    .query('subscriptions')
    .withIndex('by_accountId', (q) => q.eq('accountId', accountId))
    .unique()
  const grants = await ctx.db
    .query('planGrants')
    .withIndex('by_accountId', (q) => q.eq('accountId', accountId))
    .take(50)
  return effectivePlan(sub, grants, now)
}

export const pendingDeletion = (owner: Doc<'accounts'> | null): boolean =>
  owner?.purgeAt !== undefined

export async function assertMayHavePrivate(ctx: Ctx, owner: Doc<'accounts'>) {
  if (pendingDeletion(owner)) failReadOnly(owner.handle, 'deletion')
  const { plan } = await planOf(ctx, owner._id)
  if (!allowsPrivate(plan))
    fail(
      'plan_required',
      `${owner.handle} is on the Free plan, which is for public repositories.`,
      {
        hint: 'Upgrade the account that owns the repository to keep it private. See /pricing.',
        extra: { plan },
      },
    )
}

export function assertNotPendingDeletion(owner: Doc<'accounts'>) {
  if (pendingDeletion(owner)) failReadOnly(owner.handle, 'deletion')
}

export async function assertRepoWritable(ctx: Ctx, repo: Doc<'repos'>) {
  const owner = await ctx.db.get('accounts', repo.ownerId)
  const pending = pendingDeletion(owner)
  const plan =
    repo.visibility === 'private' && !pending
      ? (await planOf(ctx, repo.ownerId)).plan
      : 'business'
  const state = repoState(plan, repo.visibility, pending)
  if (!state.writable && state.why !== 'quota')
    failReadOnly(`${repo.owner}/${repo.name}`, state.why)
}

export async function assertPushAllowed(ctx: Ctx, repo: Doc<'repos'>) {
  await assertRepoWritable(ctx, repo)
  const { plan } = await planOf(ctx, repo.ownerId)
  const quota = overQuota(plan, await usageOf(ctx, repo.ownerId))
  const state = repoState(plan, repo.visibility, false, quota)
  if (!state.writable && state.why === 'quota')
    failQuota(`${repo.owner}/${repo.name}`, quota)
}

function failQuota(what: string, quota: Quota | null): never {
  const word =
    quota === 'storage' ? 'storage' : quota === 'push' ? 'push' : 'transfer'
  fail(
    'read_only',
    `${what}'s account is past its Free ${word} allowance, so new pushes are paused.`,
    {
      hint: 'Upgrade the account, or free up space. Nothing is deleted; clones and fetches keep working.',
      extra: { quota },
    },
  )
}

function failReadOnly(what: string, why: 'plan' | 'deletion'): never {
  if (why === 'deletion')
    fail('read_only', `${what} is waiting to be deleted, so it only reads.`, {
      hint: 'Take the deletion back in Settings, or clone what you need before it is erased.',
    })
  fail(
    'read_only',
    `${what} is private and its account is on the Free plan, so it only reads.`,
    {
      hint: 'Upgrade the account to write again. Clones, fetches and exports always work.',
    },
  )
}
