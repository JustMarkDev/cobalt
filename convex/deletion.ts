import { v } from 'convex/values'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { DELETION_GRACE_MS } from '@cobaltforge/api/plans'
import { components, internal } from './_generated/api'
import {
  env,
  internalAction,
  internalMutation,
  query,
} from './_generated/server'
import { mutation } from './lib/functions'
import { signedIn } from './lib/actor'
import { fail, out } from './lib/errors'
import { accountByHandle } from './lib/access'
import { syncGrants } from './lib/grants'
import { tally } from './lib/stats'
import { queueSweep } from './lib/sweeps'
import { dropRepoHooks } from './forge/webhooks'
import { bumpAcl } from './forge/accounts'
import type { Doc, TableNames } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const BATCH = 100

export const GHOST = { id: 'acc_deleted', handle: 'ghost' }

export const TABLES: Record<TableNames, string> = {
  accounts: 'finalize: the account row',
  actors: 'none: handles that are not people',
  memberships: 'wipe: by personId',
  invitations: 'none: addressed to an email, expire on their own',
  handleAliases: 'finalize: the account’s old addresses',
  repos: 'wipe: owned repositories, with everything in them',
  repoCounters: 'wipe: with its repository',
  repoAliases: 'wipe: with its repository',
  githubLinks: 'wipe: with its repository (deprecated table)',
  providerConnections:
    'wipe: by handle; the API server revokes the token and removes what it made at the provider',
  remoteRepos:
    'wipe: with its repository; repositories that synced through a deleted person stay, marked broken, for an admin to adopt',
  externalActors: 'none: snapshots of people on other hosts',
  remoteItems: 'wipe: with its repository',
  remoteComments: 'wipe: with its item',
  remotePatches: 'wipe: with its item',
  importJobs: 'wipe: by handle',
  importItems: 'wipe: with its job',
  hookDeliveries: 'none: expire on their own',
  providerAudit: 'wipe: by handle',
  deletedRepos: 'none: names only',
  stars: 'wipe: by handle, and with its repository',
  teams: 'none: belong to organizations',
  teamMembers: 'wipe: by handle',
  teamRepos: 'wipe: with its repository',
  forgeEvents: 'kept: the activity feed keeps the address as a pseudonym',
  stateChanges: 'scrub: actor, and with its repository',
  issueRefs: 'wipe: with its repository',
  eventHead: 'none',
  accessRevision: 'none',
  labels: 'wipe: with its repository',
  issues: 'scrub: author and assignees, and with its repository',
  issueComments: 'scrub: author, and with its issue',
  issueEvidence: 'scrub: author, and with its issue',
  changes: 'scrub: author, and with its repository',
  changeParts: 'scrub: reviews and comments, and with its change',
  reviewSeen: 'scrub: by handle, and with its change',
  presenceRooms: 'none: rooms, not people',
  repoPolicy: 'wipe: with its repository',
  auditEvents:
    'kept: an organization’s record, with the address as a pseudonym; each event expires after a year',
  orgPolicies: 'none: belong to organizations',
  repoTriggers: 'wipe: with its repository',
  repoAccessRules: 'wipe: with its repository',
  triggerRuns: 'wipe: with its repository',
  operations: 'none: expire on their own',
  pipelineRuns: 'wipe: with its repository',
  pipelineLogs: 'wipe: with its run',
  releases: 'wipe: with its repository',
  downloads: 'wipe: with its release',
  connections: 'wipe: by account',
  repoIntegrations: 'wipe: with its repository',
  links: 'wipe: by handle',
  integrationRev: 'none',
  accountPrefs: 'wipe: by handle',
  follows: 'wipe: both directions',
  peopleStats: 'wipe: by handle',
  contributions: 'wipe: by handle',
  peopleRev: 'none',
  downloadDays: 'wipe: with its repository',
  issueAssignees: 'wipe: by handle, and with its issue',
  repoGrants: 'wipe: by handle, and with its repository',
  repoExtras: 'wipe: with its repository',
  uploads: 'wipe: by owner, and with its repository',
  webhooks: 'wipe: with its repository',
  webhookDeliveries: 'wipe: with its webhook',
  pushes: 'wipe: with its repository',
  notifications: 'wipe: by handle',
  inboxes: 'wipe: by handle',
  tokens: 'wipe: by handle',
  runners: 'wipe: by account',
  runnerSeen: 'wipe: with its runner',
  authorizations: 'wipe: by handle',
  oauthState: 'none: expires on its own',
  outbox: 'none: expires on its own',
  apiLimits: 'none: expires on its own',
  healthMinutes: 'none',
  healthDays: 'none',
  tallies: 'none',
  tallySeed: 'none',
  analyticsOutbox: 'scrub: by who',
  statusCounts: 'none',
  apiIdempotency: 'none: expires on its own',
  subscriptions: 'wipe: by accountId',
  planGrants: 'wipe: by accountId',
  retiredHandles: 'none: hashes',
  repoSizes: 'wipe: with its repository',
  accountUsage: 'wipe: by accountId',
  sweeps: 'none: opaque store and upload ids, drained by the store worker',
}

export const retiredHash = (handle: string): string =>
  bytesToHex(sha256(utf8ToBytes(handle.toLowerCase())))

export const request = mutation({
  args: { confirm: v.string() },
  returns: v.string(),
  handler: async (ctx, { confirm }) => {
    const p = await signedIn(ctx)
    if (!p.session)
      fail(
        'forbidden',
        'An account is deleted from the signed-in site, not with a token.',
      )
    const account = await accountByHandle(ctx, p.handle)
    if (!account || account.kind !== 'person')
      fail('not_found', `No account ${p.handle}.`)
    if (confirm !== account.handle)
      fail(
        'invalid_request',
        `Type your address, ${account.handle}, to confirm.`,
      )
    if (account.purgeAt !== undefined)
      return out({
        purgeAt: account.purgeAt,
        requested: account.deletionRequested,
      })
    const alone = await organizationsOnlyOwnedBy(ctx, account)
    if (alone.length > 0)
      fail(
        'invalid_state',
        `You are the only owner of ${alone.join(', ')}. Make someone else an owner, or delete it, first.`,
        { extra: { organizations: alone } },
      )
    const now = Date.now()
    const purgeAt = now + DELETION_GRACE_MS
    await ctx.db.patch('accounts', account._id, {
      deletionRequested: now,
      purgeAt,
    })
    await bumpAcl(ctx, account)
    return out({ purgeAt, requested: now })
  },
})

export const cancel = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const p = await signedIn(ctx)
    const account = await accountByHandle(ctx, p.handle)
    if (!account) fail('not_found', `No account ${p.handle}.`)
    if (account.purgeAt === undefined) return out({ cancelled: false })
    if (account.purgeAt === 0)
      fail('invalid_state', 'The erasure has started and cannot be taken back.')
    await ctx.db.patch('accounts', account._id, {
      deletionRequested: undefined,
      purgeAt: undefined,
    })
    await bumpAcl(ctx, account)
    return out({ cancelled: true })
  },
})

async function organizationsOnlyOwnedBy(
  ctx: Pick<MutationCtx, 'db'>,
  person: Doc<'accounts'>,
): Promise<Array<string>> {
  const alone: Array<string> = []
  for (const m of await ctx.db
    .query('memberships')
    .withIndex('by_personId', (q) => q.eq('personId', person._id))
    .take(500)) {
    if (m.role !== 'owner') continue
    const owners = await ctx.db
      .query('memberships')
      .withIndex('by_organizationId_and_personId', (q) =>
        q.eq('organizationId', m.organizationId),
      )
      .take(5001)
    if (owners.filter((o) => o.role === 'owner').length > 1) continue
    const org = await ctx.db.get('accounts', m.organizationId)
    if (org) alone.push(org.handle)
  }
  return alone
}

export const purgeDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    for (const a of await ctx.db
      .query('accounts')
      .withIndex('by_purgeAt', (q) => q.gt('purgeAt', 0).lte('purgeAt', now))
      .take(5)) {
      await ctx.db.patch('accounts', a._id, { purgeAt: 0 })
      await ctx.scheduler.runAfter(0, internal.deletion.purge, {
        accountId: a._id,
        stage: 'wipe',
        cursor: null,
      })
    }
    return null
  },
})

const SCRUB = [
  'issues',
  'issueComments',
  'issueEvidence',
  'changes',
  'changeParts',
  'stateChanges',
  'reviewSeen',
  'analyticsOutbox',
] as const

export const purge = internalMutation({
  args: {
    accountId: v.id('accounts'),
    stage: v.string(),
    cursor: v.union(v.null(), v.string()),
  },
  handler: async (ctx, { accountId, stage, cursor }) => {
    const account = await ctx.db.get('accounts', accountId)
    if (!account || account.purgeAt === undefined) return null
    const again = (next: string, c: string | null = null) =>
      ctx.scheduler.runAfter(0, internal.deletion.purge, {
        accountId,
        stage: next,
        cursor: c,
      })
    if (stage === 'wipe') {
      const more = await wipe(ctx, account)
      await again(more ? 'wipe' : `scrub:${SCRUB[0]}`)
      return null
    }
    if (stage.startsWith('scrub:')) {
      const table = stage.slice('scrub:'.length) as (typeof SCRUB)[number]
      const next = await scrub(ctx, account, table, cursor)
      if (next !== null) await again(stage, next)
      else {
        const i = SCRUB.indexOf(table) + 1
        await again(i < SCRUB.length ? `scrub:${SCRUB[i]}` : 'finalize')
      }
      return null
    }
    await finalize(ctx, account)
    return null
  },
})

async function drop<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  docs: Array<Doc<T>>,
): Promise<boolean> {
  for (const d of docs) await ctx.db.delete(table, d._id)
  return docs.length >= BATCH
}

async function dropUploads(
  ctx: MutationCtx,
  docs: Array<Doc<'uploads'>>,
): Promise<boolean> {
  for (const d of docs) await queueSweep(ctx, 'blob', d.publicId)
  return drop(ctx, 'uploads', docs)
}

async function wipe(ctx: MutationCtx, account: Doc<'accounts'>) {
  const h = account.handle
  let more = false
  const add = async (p: Promise<boolean>) => {
    if (await p) more = true
  }
  const owned = await ctx.db
    .query('repos')
    .withIndex('by_ownerId_and_name', (q) => q.eq('ownerId', account._id))
    .take(5)
  for (const repo of owned) if (!(await wipeRepo(ctx, repo))) more = true
  if (owned.length === 5) more = true

  await add(
    drop(
      ctx,
      'memberships',
      await ctx.db
        .query('memberships')
        .withIndex('by_personId', (q) => q.eq('personId', account._id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'tokens',
      await ctx.db
        .query('tokens')
        .withIndex('by_handle_and_createdAt', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  const runners = await ctx.db
    .query('runners')
    .withIndex('by_account_and_name', (q) => q.eq('account', h))
    .take(BATCH)
  for (const r of runners)
    await add(
      drop(
        ctx,
        'runnerSeen',
        await ctx.db
          .query('runnerSeen')
          .withIndex('by_runnerId', (q) => q.eq('runnerId', r._id))
          .take(BATCH),
      ),
    )
  await add(drop(ctx, 'runners', runners))
  await add(
    drop(
      ctx,
      'authorizations',
      await ctx.db
        .query('authorizations')
        .withIndex('by_handle_and_createdAt', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(dropProviderLinks(ctx, h))
  await add(
    drop(
      ctx,
      'links',
      await ctx.db
        .query('links')
        .withIndex('by_handle_and_host', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'connections',
      await ctx.db
        .query('connections')
        .withIndex('by_account_and_integration', (q) => q.eq('account', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'accountPrefs',
      await ctx.db
        .query('accountPrefs')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'follows',
      await ctx.db
        .query('follows')
        .withIndex('by_who_and_whom', (q) => q.eq('who', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'follows',
      await ctx.db
        .query('follows')
        .withIndex('by_whom_and_who', (q) => q.eq('whom', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'stars',
      await ctx.db
        .query('stars')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'teamMembers',
      await ctx.db
        .query('teamMembers')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'issueAssignees',
      await ctx.db
        .query('issueAssignees')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoGrants',
      await ctx.db
        .query('repoGrants')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'peopleStats',
      await ctx.db
        .query('peopleStats')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'contributions',
      await ctx.db
        .query('contributions')
        .withIndex('by_handle_and_at', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'notifications',
      await ctx.db
        .query('notifications')
        .withIndex('by_handle_and_created', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'inboxes',
      await ctx.db
        .query('inboxes')
        .withIndex('by_handle', (q) => q.eq('handle', h))
        .take(BATCH),
    ),
  )
  for (const state of ['pending', 'uploaded'] as const)
    await add(
      dropUploads(
        ctx,
        await ctx.db
          .query('uploads')
          .withIndex('by_owner_and_state', (q) =>
            q.eq('owner', h).eq('state', state),
          )
          .take(BATCH),
      ),
    )
  await add(
    drop(
      ctx,
      'subscriptions',
      await ctx.db
        .query('subscriptions')
        .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'accountUsage',
      await ctx.db
        .query('accountUsage')
        .withIndex('by_accountId_and_month', (q) =>
          q.eq('accountId', account._id),
        )
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'planGrants',
      await ctx.db
        .query('planGrants')
        .withIndex('by_accountId', (q) => q.eq('accountId', account._id))
        .take(BATCH),
    ),
  )
  return more
}

async function dropProviderLinks(ctx: MutationCtx, handle: string) {
  const conns = await ctx.db
    .query('providerConnections')
    .withIndex('by_handle_and_provider_and_instance', (q) =>
      q.eq('handle', handle),
    )
    .take(20)
  for (const c of conns) {
    const linked = await ctx.db
      .query('remoteRepos')
      .withIndex('by_connectionId', (q) => q.eq('connectionId', c._id))
      .take(BATCH)
    const repos = []
    for (const r of linked) {
      const repo = await ctx.db.get('repos', r.repoId)
      repos.push({
        storeId: repo?.storeId ?? null,
        slug: r.fullName,
        webhookId: r.webhookId,
        credentialId: r.credentialId,
      })
      await ctx.db.patch('remoteRepos', r._id, {
        connectionId: null,
        webhookId: null,
        credentialId: null,
        state: 'broken',
        problem:
          'The account that kept this repository in sync was deleted. An admin can reconnect it.',
      })
    }
    await queueSweep(
      ctx,
      'provider',
      JSON.stringify({
        kind: 'disconnect',
        connectionId: c._id,
        provider: c.provider,
        instance: c.instance,
        token: c.token,
        refresh: c.refresh,
        repos,
      }),
    )
    if (linked.length < BATCH) await ctx.db.delete('providerConnections', c._id)
  }
  let more = conns.length >= 20
  const jobs = await ctx.db
    .query('importJobs')
    .withIndex('by_handle_and_created', (q) => q.eq('handle', handle))
    .take(10)
  for (const j of jobs) {
    const items = await ctx.db
      .query('importItems')
      .withIndex('by_jobId', (q) => q.eq('jobId', j._id))
      .take(BATCH)
    if (await drop(ctx, 'importItems', items)) more = true
    else await ctx.db.delete('importJobs', j._id)
  }
  if (jobs.length >= 10) more = true
  if (
    await drop(
      ctx,
      'providerAudit',
      await ctx.db
        .query('providerAudit')
        .withIndex('by_handle_and_at', (q) => q.eq('handle', handle))
        .take(BATCH),
    )
  )
    more = true
  return more
}

async function dropRemoteItems(ctx: MutationCtx, repoId: Doc<'repos'>['_id']) {
  const items = await ctx.db
    .query('remoteItems')
    .withIndex('by_repoId_and_kind_and_key', (q) => q.eq('repoId', repoId))
    .take(20)
  for (const it of items) {
    for (const c of await ctx.db
      .query('remoteComments')
      .withIndex('by_itemId_and_externalId', (q) => q.eq('itemId', it._id))
      .take(500))
      await ctx.db.delete('remoteComments', c._id)
    for (const p of await ctx.db
      .query('remotePatches')
      .withIndex('by_itemId', (q) => q.eq('itemId', it._id))
      .take(5))
      await ctx.db.delete('remotePatches', p._id)
    await ctx.db.delete('remoteItems', it._id)
  }
  return items.length >= 20
}

async function wipeRepo(ctx: MutationCtx, repo: Doc<'repos'>) {
  const id = repo._id
  let more = false
  const add = async (p: Promise<boolean>) => {
    if (await p) more = true
  }
  await dropRepoHooks(ctx, id)
  if (await dropRemoteItems(ctx, id)) more = true
  await add(
    drop(
      ctx,
      'repoSizes',
      await ctx.db
        .query('repoSizes')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoCounters',
      await ctx.db
        .query('repoCounters')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoPolicy',
      await ctx.db
        .query('repoPolicy')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoAccessRules',
      await ctx.db
        .query('repoAccessRules')
        .withIndex('by_repoId_and_ruleId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoTriggers',
      await ctx.db
        .query('repoTriggers')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'triggerRuns',
      await ctx.db
        .query('triggerRuns')
        .withIndex('by_repoId_and_at', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoExtras',
      await ctx.db
        .query('repoExtras')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'teamRepos',
      await ctx.db
        .query('teamRepos')
        .withIndex('by_repoId', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'stateChanges',
      await ctx.db
        .query('stateChanges')
        .withIndex('by_repoId_and_subject_and_at', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'issueRefs',
      await ctx.db
        .query('issueRefs')
        .withIndex('by_repoId_and_issue', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'labels',
      await ctx.db
        .query('labels')
        .withIndex('by_repoId_and_key', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoIntegrations',
      await ctx.db
        .query('repoIntegrations')
        .withIndex('by_repoId_and_integration', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'downloadDays',
      await ctx.db
        .query('downloadDays')
        .withIndex('by_repoId_and_day', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'repoGrants',
      await ctx.db
        .query('repoGrants')
        .withIndex('by_repoId_and_handle', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'stars',
      await ctx.db
        .query('stars')
        .withIndex('by_repoId_and_handle', (q) => q.eq('repoId', id))
        .take(BATCH),
    ),
  )
  await add(
    dropUploads(
      ctx,
      await ctx.db
        .query('uploads')
        .withIndex('by_attachedRepoId', (q) => q.eq('attachedRepoId', id))
        .take(BATCH),
    ),
  )
  await add(
    drop(
      ctx,
      'pushes',
      await ctx.db
        .query('pushes')
        .withIndex('by_storeId_and_ref_and_after', (q) =>
          q.eq('storeId', repo.storeId),
        )
        .take(BATCH),
    ),
  )
  for (const issue of await ctx.db
    .query('issues')
    .withIndex('by_repoId_and_number', (q) => q.eq('repoId', id))
    .take(20)) {
    let left = false
    left =
      (await drop(
        ctx,
        'issueComments',
        await ctx.db
          .query('issueComments')
          .withIndex('by_issueId', (q) => q.eq('issueId', issue._id))
          .take(BATCH),
      )) || left
    left =
      (await drop(
        ctx,
        'issueEvidence',
        await ctx.db
          .query('issueEvidence')
          .withIndex('by_issueId', (q) => q.eq('issueId', issue._id))
          .take(BATCH),
      )) || left
    left =
      (await drop(
        ctx,
        'issueAssignees',
        await ctx.db
          .query('issueAssignees')
          .withIndex('by_issueId', (q) => q.eq('issueId', issue._id))
          .take(BATCH),
      )) || left
    if (left) more = true
    else await ctx.db.delete('issues', issue._id)
  }
  for (const change of await ctx.db
    .query('changes')
    .withIndex('by_repoId_and_number', (q) => q.eq('repoId', id))
    .take(20)) {
    const parts = await drop(
      ctx,
      'changeParts',
      await ctx.db
        .query('changeParts')
        .withIndex('by_changeId_and_kind_and_seq', (q) =>
          q.eq('changeId', change._id),
        )
        .take(BATCH),
    )
    const seen = await drop(
      ctx,
      'reviewSeen',
      await ctx.db
        .query('reviewSeen')
        .withIndex('by_changeId_and_handle_and_path', (q) =>
          q.eq('changeId', change._id),
        )
        .take(BATCH),
    )
    if (parts || seen) more = true
    else await ctx.db.delete('changes', change._id)
  }
  for (const run of await ctx.db
    .query('pipelineRuns')
    .withIndex('by_repoId_and_started', (q) => q.eq('repoId', id))
    .take(20)) {
    const logs = await drop(
      ctx,
      'pipelineLogs',
      await ctx.db
        .query('pipelineLogs')
        .withIndex('by_runId_and_job_and_step', (q) => q.eq('runId', run._id))
        .take(BATCH),
    )
    if (logs) more = true
    else await ctx.db.delete('pipelineRuns', run._id)
  }
  for (const release of await ctx.db
    .query('releases')
    .withIndex('by_repoId_and_published', (q) => q.eq('repoId', id))
    .take(20)) {
    const downloads = await drop(
      ctx,
      'downloads',
      await ctx.db
        .query('downloads')
        .withIndex('by_releaseId_and_asset_and_shard', (q) =>
          q.eq('releaseId', release._id),
        )
        .take(BATCH),
    )
    if (downloads) more = true
    else await ctx.db.delete('releases', release._id)
  }
  const full = `${repo.owner}/${repo.name}`
  if (
    more ||
    (await ctx.db
      .query('issues')
      .withIndex('by_repoId_and_number', (q) => q.eq('repoId', id))
      .first()) ||
    (await ctx.db
      .query('changes')
      .withIndex('by_repoId_and_number', (q) => q.eq('repoId', id))
      .first()) ||
    (await ctx.db
      .query('pipelineRuns')
      .withIndex('by_repoId_and_started', (q) => q.eq('repoId', id))
      .first()) ||
    (await ctx.db
      .query('releases')
      .withIndex('by_repoId_and_published', (q) => q.eq('repoId', id))
      .first())
  )
    return false
  for (const a of await ctx.db
    .query('repoAliases')
    .withIndex('by_to', (q) => q.eq('to', full))
    .take(1000))
    await ctx.db.delete('repoAliases', a._id)
  for (const a of await ctx.db
    .query('repoAliases')
    .withIndex('by_from', (q) => q.eq('from', full.toLowerCase()))
    .take(10))
    await ctx.db.delete('repoAliases', a._id)
  await tally(ctx, 'repo.deleted')
  for (const l of await ctx.db
    .query('githubLinks')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .take(10))
    await ctx.db.delete('githubLinks', l._id)
  for (const r of await ctx.db
    .query('remoteRepos')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .take(10)) {
    if (r.webhookId && r.connectionId)
      await queueSweep(
        ctx,
        'provider',
        JSON.stringify({
          kind: 'unhook',
          connectionId: r.connectionId,
          provider: r.provider,
          slug: r.fullName,
          webhookId: r.webhookId,
        }),
      )
    await ctx.db.delete('remoteRepos', r._id)
  }
  await queueSweep(ctx, 'git', repo.storeId)
  await ctx.db.delete('repos', id)
  await syncGrants(ctx, id)
  return true
}

type Actorish = Doc<'issues'>['author']

export function ghostJson(text: string, handle: string, publicId: string) {
  const changed = { n: 0 }
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const hit = o.handle === handle || o.id === publicId
      return Object.fromEntries(
        Object.entries(o).map(([k, val]) => {
          if (hit && k === 'handle') {
            changed.n++
            return [k, GHOST.handle]
          }
          if (hit && k === 'id' && val === publicId) return [k, GHOST.id]
          return [k, walk(val)]
        }),
      )
    }
    return x
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const next = walk(data)
  return changed.n > 0 ? JSON.stringify(next) : null
}

async function scrub(
  ctx: MutationCtx,
  account: Doc<'accounts'>,
  table: (typeof SCRUB)[number],
  cursor: string | null,
): Promise<string | null> {
  const handle = account.handle
  const mine = (a: Actorish) => a.handle === handle || a.id === account.publicId
  const ghost = (a: Actorish): Actorish => (mine(a) ? { ...a, ...GHOST } : a)
  const opts = { numItems: 200, cursor }
  switch (table) {
    case 'issues': {
      const page = await ctx.db.query('issues').paginate(opts)
      for (const d of page.page)
        if (mine(d.author) || d.assignees.some(mine))
          await ctx.db.patch('issues', d._id, {
            author: ghost(d.author),
            assignees: d.assignees.map(ghost),
          })
      return page.isDone ? null : page.continueCursor
    }
    case 'issueComments': {
      const page = await ctx.db.query('issueComments').paginate(opts)
      for (const d of page.page)
        if (mine(d.author))
          await ctx.db.patch('issueComments', d._id, {
            author: ghost(d.author),
          })
      return page.isDone ? null : page.continueCursor
    }
    case 'issueEvidence': {
      const page = await ctx.db.query('issueEvidence').paginate(opts)
      for (const d of page.page)
        if (mine(d.by))
          await ctx.db.patch('issueEvidence', d._id, { by: ghost(d.by) })
      return page.isDone ? null : page.continueCursor
    }
    case 'changes': {
      const page = await ctx.db.query('changes').paginate(opts)
      for (const d of page.page)
        if (mine(d.author))
          await ctx.db.patch('changes', d._id, { author: ghost(d.author) })
      return page.isDone ? null : page.continueCursor
    }
    case 'changeParts': {
      const page = await ctx.db.query('changeParts').paginate(opts)
      for (const d of page.page) {
        const next = ghostJson(d.json, handle, account.publicId)
        if (next !== null)
          await ctx.db.patch('changeParts', d._id, { json: next })
      }
      return page.isDone ? null : page.continueCursor
    }
    case 'stateChanges': {
      const page = await ctx.db.query('stateChanges').paginate(opts)
      for (const d of page.page)
        if (mine(d.actor))
          await ctx.db.patch('stateChanges', d._id, { actor: ghost(d.actor) })
      return page.isDone ? null : page.continueCursor
    }
    case 'reviewSeen': {
      const page = await ctx.db.query('reviewSeen').paginate(opts)
      for (const d of page.page)
        if (d.handle === handle) await ctx.db.delete('reviewSeen', d._id)
      return page.isDone ? null : page.continueCursor
    }
    case 'analyticsOutbox': {
      const page = await ctx.db.query('analyticsOutbox').paginate(opts)
      for (const d of page.page)
        if (d.who === handle) await ctx.db.delete('analyticsOutbox', d._id)
      return page.isDone ? null : page.continueCursor
    }
  }
}

async function finalize(ctx: MutationCtx, account: Doc<'accounts'>) {
  const hashes = new Set([retiredHash(account.handle)])
  for (const a of await ctx.db.query('handleAliases').take(5000))
    if (a.accountId === account._id) {
      hashes.add(retiredHash(a.handle))
      await ctx.db.delete('handleAliases', a._id)
    }
  const now = Date.now()
  for (const hash of hashes)
    if (
      !(await ctx.db
        .query('retiredHandles')
        .withIndex('by_hash', (q) => q.eq('hash', hash))
        .unique())
    )
      await ctx.db.insert('retiredHandles', { hash, retired: now })
  await ctx.db.delete('accounts', account._id)
  await ctx.scheduler.runAfter(0, internal.deletion.erasePostHog, {
    handle: account.handle,
    attempt: 1,
  })
  if (account.authId)
    await ctx.scheduler.runAfter(0, internal.deletion.removeLogin, {
      authId: account.authId,
    })
}

export const erasePostHog = internalAction({
  args: { handle: v.string(), attempt: v.number() },
  handler: async (ctx, { handle, attempt }) => {
    const key = env.POSTHOG_PERSONAL_KEY
    const project = env.POSTHOG_PROJECT_ID
    if (!key || !project) {
      console.warn(
        '[deletion] POSTHOG_PERSONAL_KEY or POSTHOG_PROJECT_ID is not set: nothing sent to PostHog.',
      )
      return
    }
    const host = (
      env.POSTHOG_API_HOST ??
      (env.POSTHOG_HOST ?? 'https://us.i.posthog.com').replace('.i.', '.')
    ).replace(/\/$/, '')
    const res = await fetch(
      `${host}/api/projects/${encodeURIComponent(project)}/persons/bulk_delete/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          distinct_ids: [handle],
          delete_events: true,
          delete_recordings: true,
        }),
      },
    ).catch((e: unknown) => ({ ok: false, status: String(e) }))
    if (res.ok) return
    console.error(`[deletion] PostHog answered ${res.status}`)
    if (attempt < 5)
      await ctx.scheduler.runAfter(3_600_000, internal.deletion.erasePostHog, {
        handle,
        attempt: attempt + 1,
      })
  },
})

export const removeLogin = internalAction({
  args: { authId: v.string() },
  handler: async (ctx, { authId }) => {
    const adapter = components.betterAuth.adapter
    const user = await ctx.runQuery(adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', operator: 'eq', value: authId }],
    })
    const where = (field: string, value: string) =>
      [{ field, operator: 'eq' as const, value }] as never
    const clear = async (
      model: 'session' | 'account' | 'verification',
      field: string,
      value: string,
    ) => {
      let cursor: string | null = null
      for (let i = 0; i < 100; i++) {
        const r: { isDone: boolean; continueCursor: string } =
          await ctx.runMutation(adapter.deleteMany, {
            input: { model, where: where(field, value) },
            paginationOpts: { numItems: 100, cursor },
          })
        if (r.isDone) return
        cursor = r.continueCursor
      }
    }
    await clear('session', 'userId', authId)
    await clear('account', 'userId', authId)
    const email = typeof user?.email === 'string' ? user.email : null
    if (email) await clear('verification', 'identifier', email)
    await ctx.runMutation(adapter.deleteOne, {
      input: { model: 'user', where: where('_id', authId) },
    })
    return null
  },
})

export const exportData = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const p = await signedIn(ctx)
    const a = await accountByHandle(ctx, p.handle)
    if (!a) fail('not_found', `No account ${p.handle}.`)
    const h = a.handle
    const take = 1000
    const repos = await ctx.db
      .query('repos')
      .withIndex('by_ownerId_and_name', (q) => q.eq('ownerId', a._id))
      .take(200)
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_personId', (q) => q.eq('personId', a._id))
      .take(200)
    const organizations = []
    for (const m of memberships) {
      const org = await ctx.db.get('accounts', m.organizationId)
      if (org) organizations.push({ handle: org.handle, role: m.role })
    }
    const prefs = await ctx.db
      .query('accountPrefs')
      .withIndex('by_handle', (q) => q.eq('handle', h))
      .unique()
    return out({
      exported: new Date().toISOString(),
      format: 'cobalt account export, version 1',
      account: {
        handle: a.handle,
        name: a.name,
        bio: a.bio,
        created: new Date(a.created).toISOString(),
      },
      preferences: prefs ? safeJson(prefs.prefs) : null,
      organizations,
      repositories: repos.map((r) => ({
        name: `${r.owner}/${r.name}`,
        description: r.description,
        visibility: r.visibility,
        created: new Date(r.created).toISOString(),
        clone: `git clone <your cobalt remote>/${r.owner}/${r.name}`,
      })),
      following: (
        await ctx.db
          .query('follows')
          .withIndex('by_who_and_whom', (q) => q.eq('who', h))
          .take(take)
      ).map((f) => f.whom),
      linkedAccounts: (
        await ctx.db
          .query('links')
          .withIndex('by_handle_and_host', (q) => q.eq('handle', h))
          .take(50)
      ).map((l) => ({ host: l.host })),
      tokens: (
        await ctx.db
          .query('tokens')
          .withIndex('by_handle_and_createdAt', (q) => q.eq('handle', h))
          .take(200)
      ).map((t) => ({
        id: t.publicId,
        created: new Date(t.createdAt).toISOString(),
      })),
      notes: [
        'Repositories are plain git: clone each one, with its history and its sealed secrets, from the list above.',
        'Issues and changes in your repositories live in those repositories’ settings and API; use `cb` to export them.',
        'What you wrote in other people’s repositories belongs to those repositories.',
      ],
    })
  },
})

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
