import { v } from 'convex/values'
import { aboutPatch } from '@cobaltforge/api/forge/about'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { signedIn, system } from '../lib/actor'
import { repoByKey, resolve, roleIn } from '../lib/access'
import { fail, out } from '../lib/errors'
import { provider } from '../schema'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

const remoteState = v.union(
  v.literal('syncing'),
  v.literal('linked'),
  v.literal('delayed'),
  v.literal('broken'),
  v.literal('archived'),
  v.literal('gone'),
)

const meta = v.object({
  private: v.boolean(),
  archived: v.boolean(),
  defaultBranch: v.string(),
  description: v.string(),
  stars: v.number(),
  forks: v.number(),
  license: v.union(v.null(), v.string()),
  website: v.union(v.null(), v.string()),
})

function conn(c: Doc<'providerConnections'>) {
  const { _id, _creationTime, ...rest } = c
  void _creationTime
  return { ...rest, id: _id as string }
}

async function remote(ctx: QueryCtx, r: Doc<'remoteRepos'>) {
  const repo = await ctx.db.get('repos', r.repoId)
  const { _id, _creationTime, repoId, ...rest } = r
  void _creationTime
  void repoId
  return {
    ...rest,
    id: _id as string,
    repo: repo ? `${repo.owner}/${repo.name}` : '',
    storeId: repo?.storeId ?? '',
    connectionId: (r.connectionId as string | null) ?? null,
    etags: r.etags ?? {},
    importedAt: r.importedAt ?? null,
  }
}

const connId = (ctx: QueryCtx, id: string) =>
  ctx.db.normalizeId('providerConnections', id)
const remoteId = (ctx: QueryCtx, id: string) =>
  ctx.db.normalizeId('remoteRepos', id)

export const connection = query({
  args: { handle: v.string(), provider, instance: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const c = await ctx.db
      .query('providerConnections')
      .withIndex('by_handle_and_provider_and_instance', (q) =>
        q
          .eq('handle', a.handle)
          .eq('provider', a.provider)
          .eq('instance', a.instance),
      )
      .unique()
    return out(c ? conn(c) : null)
  },
})

export const connectionById = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = connId(ctx, a.id)
    const c = id && (await ctx.db.get('providerConnections', id))
    return out(c ? conn(c) : null)
  },
})

export const connections = query({
  args: { handle: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const all = await ctx.db
      .query('providerConnections')
      .withIndex('by_handle_and_provider_and_instance', (q) =>
        q.eq('handle', a.handle),
      )
      .take(20)
    return out(all.map(conn))
  },
})

const connectionFields = {
  handle: v.string(),
  provider,
  instance: v.string(),
  externalId: v.string(),
  login: v.string(),
  token: v.union(v.null(), v.string()),
  refresh: v.union(v.null(), v.string()),
  keyId: v.union(v.null(), v.string()),
  expiresAt: v.union(v.null(), v.number()),
  scopes: v.array(v.string()),
  state: v.union(v.literal('ok'), v.literal('needs_reconnect')),
  problem: v.union(v.null(), v.string()),
}

export const saveConnection = mutation({
  args: { c: v.object(connectionFields), now: v.number() },
  returns: v.string(),
  handler: async (ctx, { c, now }) => {
    await system(ctx)
    const had = await ctx.db
      .query('providerConnections')
      .withIndex('by_handle_and_provider_and_instance', (q) =>
        q
          .eq('handle', c.handle)
          .eq('provider', c.provider)
          .eq('instance', c.instance),
      )
      .unique()
    if (had) {
      await ctx.db.patch('providerConnections', had._id, {
        ...c,
        refreshLease: null,
        updated: now,
      })
      return out(conn((await ctx.db.get('providerConnections', had._id))!))
    }
    const id = await ctx.db.insert('providerConnections', {
      ...c,
      refreshLease: null,
      created: now,
      updated: now,
    })
    return out(conn((await ctx.db.get('providerConnections', id))!))
  },
})

export const patchConnection = mutation({
  args: {
    id: v.string(),
    patch: v.object({
      token: v.optional(v.union(v.null(), v.string())),
      refresh: v.optional(v.union(v.null(), v.string())),
      keyId: v.optional(v.union(v.null(), v.string())),
      expiresAt: v.optional(v.union(v.null(), v.number())),
      state: v.optional(v.union(v.literal('ok'), v.literal('needs_reconnect'))),
      problem: v.optional(v.union(v.null(), v.string())),
      refreshLease: v.optional(v.union(v.null(), v.number())),
      scopes: v.optional(v.array(v.string())),
    }),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = connId(ctx, a.id)
    if (id && (await ctx.db.get('providerConnections', id)))
      await ctx.db.patch('providerConnections', id, {
        ...a.patch,
        updated: a.now,
      })
    return out(null)
  },
})

export const deleteConnection = mutation({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = connId(ctx, a.id)
    if (id && (await ctx.db.get('providerConnections', id)))
      await ctx.db.delete('providerConnections', id)
    return out(null)
  },
})

export const leaseRefresh = mutation({
  args: { id: v.string(), now: v.number(), ms: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = connId(ctx, a.id)
    const c = id && (await ctx.db.get('providerConnections', id))
    if (!c || (c.refreshLease !== null && c.refreshLease > a.now))
      return out(null)
    await ctx.db.patch('providerConnections', c._id, {
      refreshLease: a.now + a.ms,
    })
    return out(conn({ ...c, refreshLease: a.now + a.ms }))
  },
})

export const remoteByExternal = query({
  args: { provider, instance: v.string(), externalId: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const r = await ctx.db
      .query('remoteRepos')
      .withIndex('by_provider_and_instance_and_externalId', (q) =>
        q
          .eq('provider', a.provider)
          .eq('instance', a.instance)
          .eq('externalId', a.externalId),
      )
      .unique()
    return out(r ? await remote(ctx, r) : null)
  },
})

export const remoteOfRepo = query({
  args: { repo: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out(null)
    const r = await ctx.db
      .query('remoteRepos')
      .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
      .first()
    return out(r ? await remote(ctx, r) : null)
  },
})

export const claims = query({
  args: { provider, instance: v.string(), ids: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const held: Record<string, string> = {}
    for (const id of a.ids.slice(0, 1000)) {
      const r = await ctx.db
        .query('remoteRepos')
        .withIndex('by_provider_and_instance_and_externalId', (q) =>
          q
            .eq('provider', a.provider)
            .eq('instance', a.instance)
            .eq('externalId', id),
        )
        .unique()
      const repo = r && (await ctx.db.get('repos', r.repoId))
      if (repo) held[id] = `${repo.owner}/${repo.name}`
    }
    return out(held)
  },
})

export const remotesOfConnection = query({
  args: { connectionId: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = connId(ctx, a.connectionId)
    if (!id) return out([])
    const rs = await ctx.db
      .query('remoteRepos')
      .withIndex('by_connectionId', (q) => q.eq('connectionId', id))
      .take(1000)
    return out(await Promise.all(rs.map((r) => remote(ctx, r))))
  },
})

export const remotesOfInstallation = query({
  args: { installation: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const rs = await ctx.db
      .query('remoteRepos')
      .withIndex('by_installation', (q) => q.eq('installation', a.installation))
      .take(1000)
    return out(await Promise.all(rs.map((r) => remote(ctx, r))))
  },
})

export const claimRemote = mutation({
  args: {
    r: v.object({
      provider,
      instance: v.string(),
      externalId: v.string(),
      fullName: v.string(),
      repo: v.string(),
      connectionId: v.union(v.null(), v.string()),
      by: v.string(),
      state: remoteState,
      problem: v.union(v.null(), v.string()),
      installation: v.union(v.null(), v.number()),
      webhookId: v.union(v.null(), v.string()),
      credentialId: v.union(v.null(), v.string()),
      lfs: v.boolean(),
      meta,
      lastPull: v.number(),
      lastSync: v.union(v.null(), v.number()),
      at: v.number(),
    }),
  },
  returns: v.string(),
  handler: async (ctx, { r }) => {
    await system(ctx)
    const repo = await repoByKey(ctx, r.repo)
    if (!repo) fail('not_found', `No repository ${r.repo}.`)
    const held = await ctx.db
      .query('remoteRepos')
      .withIndex('by_provider_and_instance_and_externalId', (q) =>
        q
          .eq('provider', r.provider)
          .eq('instance', r.instance)
          .eq('externalId', r.externalId),
      )
      .unique()
    if (held && held.repoId !== repo._id) {
      const other = await ctx.db.get('repos', held.repoId)
      fail(
        'invalid_state',
        `${r.fullName} is already linked to ${other ? `${other.owner}/${other.name}` : 'another repository'}.`,
        { hint: 'A provider repository feeds one repository here.' },
      )
    }
    if (held) return out(await remote(ctx, held))
    const connectionId = r.connectionId ? connId(ctx, r.connectionId) : null
    const { repo: _full, ...fields } = r
    void _full
    const id = await ctx.db.insert('remoteRepos', {
      ...fields,
      repoId: repo._id,
      connectionId,
    })
    return out(await remote(ctx, (await ctx.db.get('remoteRepos', id))!))
  },
})

export const patchRemote = mutation({
  args: {
    id: v.string(),
    patch: v.object({
      state: v.optional(remoteState),
      problem: v.optional(v.union(v.null(), v.string())),
      fullName: v.optional(v.string()),
      connectionId: v.optional(v.union(v.null(), v.string())),
      by: v.optional(v.string()),
      installation: v.optional(v.union(v.null(), v.number())),
      webhookId: v.optional(v.union(v.null(), v.string())),
      credentialId: v.optional(v.union(v.null(), v.string())),
      lfs: v.optional(v.boolean()),
      meta: v.optional(meta),
      lastPull: v.optional(v.number()),
      lastSync: v.optional(v.union(v.null(), v.number())),
      etags: v.optional(v.record(v.string(), v.string())),
      importedAt: v.optional(v.union(v.null(), v.number())),
    }),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = remoteId(ctx, a.id)
    const r = id && (await ctx.db.get('remoteRepos', id))
    if (!r) return out(null)
    const { connectionId, importedAt, ...rest } = a.patch
    await ctx.db.patch('remoteRepos', r._id, {
      ...rest,
      ...(connectionId === undefined
        ? {}
        : {
            connectionId: connectionId ? connId(ctx, connectionId) : null,
          }),
      ...(importedAt === undefined
        ? {}
        : { importedAt: importedAt ?? undefined }),
    })
    if (a.patch.meta) await mirrorMeta(ctx, r.repoId, a.patch.meta)
    return out(null)
  },
})

async function mirrorMeta(
  ctx: MutationCtx,
  repoId: Id<'repos'>,
  m: Doc<'remoteRepos'>['meta'],
) {
  const repo = await ctx.db.get('repos', repoId)
  if (!repo) return
  const next = {
    stars: m.stars,
    forks: m.forks,
    license: m.license,
    website: m.website,
    ...(m.description ? { description: m.description } : {}),
  }
  const same = (Object.keys(next) as Array<keyof typeof next>).every(
    (k) => repo[k] === next[k],
  )
  if (!same)
    await ctx.db.patch('repos', repo._id, {
      ...next,
      version: repo.version + 1,
    })
}

const aboutV = v.object({
  description: v.string(),
  license: v.union(v.null(), v.string()),
  website: v.union(v.null(), v.string()),
})

/** The provider's description, license and website, where nobody here set them otherwise. */
export const setAbout = mutation({
  args: { repo: v.string(), about: aboutV, was: v.union(v.null(), aboutV) },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out(null)
    const next = aboutPatch(
      {
        description: repo.description,
        license: repo.license,
        website: repo.website,
      },
      a.about,
      a.was,
    )
    if (next)
      await ctx.db.patch('repos', repo._id, {
        ...next,
        version: repo.version + 1,
      })
    return out(null)
  },
})

export const setLanguages = mutation({
  args: {
    repo: v.string(),
    languages: v.array(v.array(v.union(v.string(), v.number()))),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (repo && JSON.stringify(repo.languages) !== JSON.stringify(a.languages))
      await ctx.db.patch('repos', repo._id, {
        languages: a.languages,
        version: repo.version + 1,
      })
    return out(null)
  },
})

export const dropRemote = mutation({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = remoteId(ctx, a.id)
    if (id && (await ctx.db.get('remoteRepos', id)))
      await ctx.db.delete('remoteRepos', id)
    return out(null)
  },
})

export const stale = query({
  args: { before: v.number(), max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const rs = await ctx.db
      .query('remoteRepos')
      .withIndex('by_lastPull', (q) => q.lt('lastPull', a.before))
      .take(Math.min(a.max, 200) * 2)
    return out(
      await Promise.all(
        rs
          .filter((r) => r.state !== 'gone')
          .slice(0, a.max)
          .map((r) => remote(ctx, r)),
      ),
    )
  },
})

export const seen = mutation({
  args: { provider, deliveryId: v.string(), now: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const had = await ctx.db
      .query('hookDeliveries')
      .withIndex('by_provider_and_deliveryId', (q) =>
        q.eq('provider', a.provider).eq('deliveryId', a.deliveryId),
      )
      .unique()
    if (had) return out(true)
    await ctx.db.insert('hookDeliveries', {
      provider: a.provider,
      deliveryId: a.deliveryId,
      at: a.now,
    })
    return out(false)
  },
})

export const sweepDeliveries = mutation({
  args: { before: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const old = await ctx.db
      .query('hookDeliveries')
      .withIndex('by_at', (q) => q.lt('at', a.before))
      .take(500)
    for (const d of old) await ctx.db.delete('hookDeliveries', d._id)
    return out(old.length)
  },
})

function jobOf(j: Doc<'importJobs'>) {
  const { _id, _creationTime, connectionId, ...rest } = j
  void _creationTime
  return {
    ...rest,
    id: _id as string,
    connectionId: (connectionId as string | null) ?? null,
  }
}

function itemOf(i: Doc<'importItems'>) {
  const { _id, _creationTime, jobId, ...rest } = i
  void _creationTime
  return { ...rest, id: _id as string, jobId: jobId as string }
}

export const createJob = mutation({
  args: {
    job: v.object({
      handle: v.string(),
      owner: v.string(),
      provider,
      instance: v.string(),
      connectionId: v.union(v.null(), v.string()),
      total: v.number(),
      created: v.number(),
    }),
    items: v.array(
      v.object({
        externalId: v.string(),
        slug: v.string(),
        name: v.string(),
        visibility: v.union(v.literal('public'), v.literal('private')),
        defaultBranch: v.string(),
        installation: v.union(v.null(), v.number()),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, { job, items }) => {
    await system(ctx)
    if (items.length > 1000)
      fail('invalid_request', 'At most 1000 repositories in one import.')
    const jobId = await ctx.db.insert('importJobs', {
      ...job,
      connectionId: job.connectionId ? connId(ctx, job.connectionId) : null,
      state: items.length ? 'running' : 'done',
      done: 0,
      failed: 0,
      updated: job.created,
    })
    for (const it of items)
      await ctx.db.insert('importItems', {
        ...it,
        jobId,
        state: 'queued',
        attempts: 0,
        lease: 0,
        error: null,
        repo: null,
        updated: job.created,
      })
    return out(jobId)
  },
})

export const job = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = ctx.db.normalizeId('importJobs', a.id)
    const j = id && (await ctx.db.get('importJobs', id))
    if (!j) return out(null)
    const items = await ctx.db
      .query('importItems')
      .withIndex('by_jobId', (q) => q.eq('jobId', j._id))
      .take(1000)
    return out({ job: jobOf(j), items: items.map(itemOf) })
  },
})

export const claimItems = mutation({
  args: { now: v.number(), leaseMs: v.number(), max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const got: Array<{
      item: ReturnType<typeof itemOf>
      job: ReturnType<typeof jobOf>
    }> = []
    for (const state of ['queued', 'running'] as const) {
      const due = await ctx.db
        .query('importItems')
        .withIndex('by_state_and_lease', (q) =>
          q.eq('state', state).lte('lease', a.now),
        )
        .take(a.max * 2)
      for (const it of due) {
        if (got.length >= a.max) break
        const j = await ctx.db.get('importJobs', it.jobId)
        if (!j || j.state !== 'running') continue
        const lease = a.now + a.leaseMs
        await ctx.db.patch('importItems', it._id, {
          state: 'running',
          lease,
          attempts: it.attempts + 1,
        })
        got.push({
          item: itemOf({
            ...it,
            state: 'running',
            lease,
            attempts: it.attempts + 1,
          }),
          job: jobOf(j),
        })
      }
    }
    return out(got)
  },
})

export const finishItem = mutation({
  args: {
    id: v.string(),
    state: v.union(
      v.literal('done'),
      v.literal('skipped'),
      v.literal('failed'),
      v.literal('queued'),
    ),
    repo: v.union(v.null(), v.string()),
    error: v.union(v.null(), v.string()),
    retryAt: v.number(),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const id = ctx.db.normalizeId('importItems', a.id)
    const it = id && (await ctx.db.get('importItems', id))
    if (!it || it.state === 'done' || it.state === 'failed') return out(null)
    if (a.state === 'queued') {
      await ctx.db.patch('importItems', it._id, {
        state: 'queued',
        lease: a.retryAt,
        error: a.error,
        updated: a.now,
      })
      return out(null)
    }
    await ctx.db.patch('importItems', it._id, {
      state: a.state,
      error: a.error,
      repo: a.repo,
      updated: a.now,
    })
    const j = await ctx.db.get('importJobs', it.jobId)
    if (j) {
      const done = j.done + (a.state === 'failed' ? 0 : 1)
      const failed = j.failed + (a.state === 'failed' ? 1 : 0)
      await ctx.db.patch('importJobs', j._id, {
        done,
        failed,
        updated: a.now,
        ...(done + failed >= j.total ? { state: 'done' as const } : {}),
      })
    }
    return out(null)
  },
})

const auditAction = v.union(
  v.literal('connected'),
  v.literal('reconnected'),
  v.literal('disconnected'),
  v.literal('imported'),
  v.literal('adopted'),
  v.literal('unlinked'),
  v.literal('relinked'),
  v.literal('published'),
  v.literal('needs_reconnect'),
)

export const audit = mutation({
  args: {
    a: v.object({
      handle: v.string(),
      provider,
      action: auditAction,
      repo: v.union(v.null(), v.string()),
      detail: v.union(v.null(), v.string()),
      at: v.number(),
    }),
  },
  returns: v.string(),
  handler: async (ctx, { a }) => {
    await system(ctx)
    await ctx.db.insert('providerAudit', a)
    return out(null)
  },
})

export const auditOf = query({
  args: { handle: v.string(), max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const rows = await ctx.db
      .query('providerAudit')
      .withIndex('by_handle_and_at', (q) => q.eq('handle', a.handle))
      .order('desc')
      .take(Math.min(a.max, 200))
    return out(
      rows.map(({ _id, _creationTime, ...r }) => {
        void _id
        void _creationTime
        return r
      }),
    )
  },
})

export const upsertActor = mutation({
  args: {
    a: v.object({
      provider,
      instance: v.string(),
      externalId: v.string(),
      login: v.string(),
      name: v.union(v.null(), v.string()),
      avatar: v.union(v.null(), v.string()),
      deleted: v.boolean(),
    }),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, { a, now }) => {
    await system(ctx)
    const had = await ctx.db
      .query('externalActors')
      .withIndex('by_provider_and_instance_and_externalId', (q) =>
        q
          .eq('provider', a.provider)
          .eq('instance', a.instance)
          .eq('externalId', a.externalId),
      )
      .unique()
    if (had) {
      await ctx.db.patch('externalActors', had._id, { ...a, updated: now })
      return out(had._id)
    }
    return out(await ctx.db.insert('externalActors', { ...a, updated: now }))
  },
})

const SWEEP_LEASE_MS = 5 * 60_000

export const claimSweeps = mutation({
  args: { now: v.number(), max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const due = await ctx.db
      .query('sweeps')
      .withIndex('by_kind_and_lease', (q) =>
        q.eq('kind', 'provider').lt('lease', a.now),
      )
      .take(Math.min(a.max, 50))
    for (const s of due)
      await ctx.db.patch('sweeps', s._id, { lease: a.now + SWEEP_LEASE_MS })
    return out(due.map((s) => ({ id: s._id as string, key: s.key })))
  },
})

export const doneSweeps = mutation({
  args: { ids: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    for (const raw of a.ids) {
      const id = ctx.db.normalizeId('sweeps', raw)
      if (id && (await ctx.db.get('sweeps', id)))
        await ctx.db.delete('sweeps', id)
    }
    return out(null)
  },
})

export const requireAdmin = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    const acct = await ctx.db.get('accounts', repo.ownerId)
    const ok =
      acct &&
      (acct.kind === 'person'
        ? acct.handle === p.handle
        : ['owner', 'admin'].includes(
            (await roleIn(ctx, acct, p.handle)) ?? '',
          ))
    if (!ok)
      fail(
        'forbidden',
        `Only an admin of ${repo.owner}/${repo.name} can do this.`,
      )
    return out(null)
  },
})

const itemKind = v.union(
  v.literal('pull'),
  v.literal('issue'),
  v.literal('release'),
)

async function actorOf(ctx: QueryCtx, id: Id<'externalActors'> | null) {
  const a = id && (await ctx.db.get('externalActors', id))
  if (!a) return null
  const { _id, _creationTime, updated, ...rest } = a
  void _creationTime
  void updated
  return { ...rest, id: _id as string }
}

async function itemOut(ctx: QueryCtx, repo: string, i: Doc<'remoteItems'>) {
  const comments = await ctx.db
    .query('remoteComments')
    .withIndex('by_itemId_and_externalId', (q) => q.eq('itemId', i._id))
    .take(1000)
  const patch = await ctx.db
    .query('remotePatches')
    .withIndex('by_itemId', (q) => q.eq('itemId', i._id))
    .first()
  return {
    id: i._id as string,
    repo,
    kind: i.kind,
    number: i.number,
    key: i.key,
    title: i.title,
    body: i.body,
    state: i.state,
    author: await actorOf(ctx, i.authorId),
    labels: i.labels,
    url: i.url,
    created: i.created,
    updated: i.updated,
    closed: i.closed,
    merged: i.merged,
    head: i.head ?? null,
    flags: i.flags ?? null,
    hasPatch: Boolean(patch),
    comments: comments.filter((c) => c.removed === null).length,
    removed: i.removed
      ? { at: i.removed.at, by: await actorOf(ctx, i.removed.byId) }
      : null,
  }
}

export const itemsDue = query({
  args: { now: v.number(), max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const rs = await ctx.db
      .query('remoteRepos')
      .withIndex('by_itemsDue', (q) =>
        q.gte('itemsDue', 0).lte('itemsDue', a.now),
      )
      .take(Math.min(a.max, 50))
    return out(
      await Promise.all(
        rs.filter((r) => r.state !== 'gone').map((r) => remote(ctx, r)),
      ),
    )
  },
})

export const setItemsDue = mutation({
  args: { repo: v.string(), at: v.union(v.null(), v.number()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out(null)
    const r = await ctx.db
      .query('remoteRepos')
      .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
      .first()
    if (r)
      await ctx.db.patch('remoteRepos', r._id, { itemsDue: a.at ?? undefined })
    return out(null)
  },
})

const itemFields = {
  kind: itemKind,
  number: v.number(),
  key: v.string(),
  title: v.string(),
  body: v.string(),
  state: v.string(),
  authorId: v.union(v.null(), v.string()),
  labels: v.array(v.string()),
  url: v.string(),
  created: v.number(),
  updated: v.number(),
  closed: v.union(v.null(), v.number()),
  merged: v.union(v.null(), v.number()),
  head: v.union(
    v.null(),
    v.object({
      ref: v.string(),
      sha: v.string(),
      base: v.string(),
      fromFork: v.boolean(),
      commitsHere: v.union(v.null(), v.boolean()),
    }),
  ),
  flags: v.union(
    v.null(),
    v.object({ draft: v.boolean(), prerelease: v.boolean() }),
  ),
}

export const putItem = mutation({
  args: { repo: v.string(), item: v.object(itemFields) },
  returns: v.string(),
  handler: async (ctx, { repo: full, item }) => {
    await system(ctx)
    const repo = await repoByKey(ctx, full)
    if (!repo) fail('not_found', `No repository ${full}.`)
    const authorId = item.authorId
      ? ctx.db.normalizeId('externalActors', item.authorId)
      : null
    const doc = {
      ...item,
      repoId: repo._id,
      authorId,
      head: item.head ?? undefined,
      flags: item.flags ?? undefined,
      body: item.body.slice(0, 200_000),
      title: item.title.slice(0, 1000),
    }
    const had = await ctx.db
      .query('remoteItems')
      .withIndex('by_repoId_and_kind_and_key', (q) =>
        q.eq('repoId', repo._id).eq('kind', item.kind).eq('key', item.key),
      )
      .unique()
    if (had) {
      const same =
        had.updated === doc.updated &&
        had.state === doc.state &&
        had.title === doc.title &&
        had.body === doc.body &&
        JSON.stringify(had.head ?? null) === JSON.stringify(doc.head ?? null) &&
        had.removed === null
      if (same) return out(null)
      await ctx.db.patch('remoteItems', had._id, { ...doc, removed: null })
      return out(had._id)
    }
    return out(
      await ctx.db.insert('remoteItems', {
        ...doc,
        hasPatch: false,
        comments: 0,
        removed: null,
      }),
    )
  },
})

export const itemsOf = query({
  args: { repo: v.string(), kind: itemKind, max: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out([])
    const items = await ctx.db
      .query('remoteItems')
      .withIndex('by_repoId_and_kind_and_updated', (q) =>
        q.eq('repoId', repo._id).eq('kind', a.kind),
      )
      .order('desc')
      .take(Math.min(a.max, 200))
    const full = `${repo.owner}/${repo.name}`
    return out(await Promise.all(items.map((i) => itemOut(ctx, full, i))))
  },
})

export const item = query({
  args: { repo: v.string(), kind: itemKind, key: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out(null)
    const i = await ctx.db
      .query('remoteItems')
      .withIndex('by_repoId_and_kind_and_key', (q) =>
        q.eq('repoId', repo._id).eq('kind', a.kind).eq('key', a.key),
      )
      .unique()
    return out(i ? await itemOut(ctx, `${repo.owner}/${repo.name}`, i) : null)
  },
})

export const markRemoved = mutation({
  args: {
    repo: v.string(),
    kind: itemKind,
    key: v.string(),
    at: v.number(),
    byId: v.union(v.null(), v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await repoByKey(ctx, a.repo)
    if (!repo) return out(null)
    const i = await ctx.db
      .query('remoteItems')
      .withIndex('by_repoId_and_kind_and_key', (q) =>
        q.eq('repoId', repo._id).eq('kind', a.kind).eq('key', a.key),
      )
      .unique()
    if (i && !i.removed)
      await ctx.db.patch('remoteItems', i._id, {
        removed: {
          at: a.at,
          byId: a.byId ? ctx.db.normalizeId('externalActors', a.byId) : null,
        },
      })
    return out(null)
  },
})

export const putComments = mutation({
  args: {
    itemId: v.string(),
    comments: v.array(
      v.object({
        externalId: v.string(),
        body: v.string(),
        authorId: v.union(v.null(), v.string()),
        created: v.number(),
        updated: v.number(),
      }),
    ),
    now: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const itemId = ctx.db.normalizeId('remoteItems', a.itemId)
    if (!itemId || !(await ctx.db.get('remoteItems', itemId))) return out(null)
    const had = await ctx.db
      .query('remoteComments')
      .withIndex('by_itemId_and_externalId', (q) => q.eq('itemId', itemId))
      .take(1000)
    const byId = new Map(had.map((c) => [c.externalId, c]))
    for (const c of a.comments.slice(0, 1000)) {
      const doc = {
        itemId,
        externalId: c.externalId,
        body: c.body.slice(0, 100_000),
        authorId: c.authorId
          ? ctx.db.normalizeId('externalActors', c.authorId)
          : null,
        created: c.created,
        updated: c.updated,
        removed: null,
      }
      const old = byId.get(c.externalId)
      if (!old) await ctx.db.insert('remoteComments', doc)
      else if (old.updated !== c.updated || old.removed !== null)
        await ctx.db.patch('remoteComments', old._id, doc)
      byId.delete(c.externalId)
    }
    for (const gone of byId.values())
      if (gone.removed === null)
        await ctx.db.patch('remoteComments', gone._id, { removed: a.now })
    return out(null)
  },
})

export const commentsOf = query({
  args: { itemId: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const itemId = ctx.db.normalizeId('remoteItems', a.itemId)
    if (!itemId) return out([])
    const cs = await ctx.db
      .query('remoteComments')
      .withIndex('by_itemId_and_externalId', (q) => q.eq('itemId', itemId))
      .take(1000)
    const shown = await Promise.all(
      cs.map(async (c) => ({
        externalId: c.externalId,
        body: c.body,
        author: await actorOf(ctx, c.authorId),
        created: c.created,
        updated: c.updated,
        removed: c.removed,
      })),
    )
    return out(shown.sort((x, y) => x.created - y.created))
  },
})

const PATCH_MAX = 900 * 1024

export const putPatch = mutation({
  args: { itemId: v.string(), text: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const itemId = ctx.db.normalizeId('remoteItems', a.itemId)
    if (!itemId || !(await ctx.db.get('remoteItems', itemId))) return out(null)
    const doc = {
      itemId,
      text: a.text.slice(0, PATCH_MAX),
      truncated: a.text.length > PATCH_MAX,
    }
    const had = await ctx.db
      .query('remotePatches')
      .withIndex('by_itemId', (q) => q.eq('itemId', itemId))
      .first()
    if (had) await ctx.db.replace('remotePatches', had._id, doc)
    else await ctx.db.insert('remotePatches', doc)
    await ctx.db.patch('remoteItems', itemId, { hasPatch: true })
    return out(null)
  },
})

export const patchOf = query({
  args: { itemId: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const itemId = ctx.db.normalizeId('remoteItems', a.itemId)
    const p =
      itemId &&
      (await ctx.db
        .query('remotePatches')
        .withIndex('by_itemId', (q) => q.eq('itemId', itemId))
        .first())
    return out(p ? { text: p.text, truncated: p.truncated } : null)
  },
})

export const jobProgress = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const id = ctx.db.normalizeId('importJobs', a.id)
    const j = id && (await ctx.db.get('importJobs', id))
    if (!j || j.handle !== p.handle) return out(null)
    const items = await ctx.db
      .query('importItems')
      .withIndex('by_jobId', (q) => q.eq('jobId', j._id))
      .take(1000)
    return out({
      state: j.state,
      total: j.total,
      done: j.done,
      failed: j.failed,
      items: items.map((i) => ({
        slug: i.slug,
        state: i.state,
        repo: i.repo,
        error: i.error,
      })),
    })
  },
})

/**
 * Languages and license read from a repository's own files, after a push to
 * its default branch. A repository linked to a provider takes both from it.
 */
export const setDetected = mutation({
  args: {
    storeId: v.string(),
    ref: v.string(),
    languages: v.array(v.array(v.union(v.string(), v.number()))),
    license: v.union(v.null(), v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo || repo.upstream || a.ref !== `refs/heads/${repo.defaultBranch}`)
      return out(null)
    const patch: Partial<Doc<'repos'>> = {}
    if (JSON.stringify(repo.languages) !== JSON.stringify(a.languages))
      patch.languages = a.languages
    if (repo.license !== a.license) patch.license = a.license
    if (Object.keys(patch).length)
      await ctx.db.patch('repos', repo._id, {
        ...patch,
        version: repo.version + 1,
      })
    return out(null)
  },
})
