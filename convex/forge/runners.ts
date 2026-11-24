import { v } from 'convex/values'
import { newId } from '@cobaltforge/api/ids'
import { runnerScopes } from '@cobaltforge/api/auth'
import {
  LEASE_MS,
  MAX_CONCURRENCY,
  MAX_LABELS,
  MAX_RUNNERS,
  holds,
  labelShape,
  labelsMatch,
  mayServe,
  normalizeLabels,
  runnerStatus,
} from '@cobaltforge/api/runners'
import type { RunnerLike } from '@cobaltforge/api/runners'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { actorOf, signedIn } from '../lib/actor'
import type { Actor } from '../lib/actor'
import {
  accountByHandle,
  isMember,
  repoByPublicId,
  resolve,
  roleIn,
} from '../lib/access'
import { fail, finish, out } from '../lib/errors'
import { iso, repoUrl, urls } from '../lib/present'
import { mintToken, revokeToken, toRefs } from '../lib/tokens'
import {
  applyReport,
  applyWait,
  claimedJob,
  expireDue,
  load,
  requeueExpired,
  runOf,
  save,
  shown,
} from './pipelines'
import type { PipelineRun } from './pipelines'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

const RUNNER_TTL_MS = 365 * 86_400_000

async function seenAt(ctx: QueryCtx, r: Doc<'runners'>) {
  const s = await ctx.db
    .query('runnerSeen')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', r._id))
    .unique()
  return s?.at ?? null
}

async function repoNames(ctx: QueryCtx, r: Doc<'runners'>) {
  if (!r.repos) return null
  const names: Array<string> = []
  for (const id of r.repos) {
    const repo = await repoByPublicId(ctx, id)
    if (repo && repo.owner === r.account)
      names.push(`${repo.owner}/${repo.name}`.toLowerCase())
  }
  return names
}

async function like(ctx: QueryCtx, r: Doc<'runners'>): Promise<RunnerLike> {
  return {
    account: r.account,
    labels: r.labels,
    repos: await repoNames(ctx, r),
    concurrency: r.concurrency,
    disabled: r.status === 'disabled',
    lastSeen: await seenAt(ctx, r),
  }
}

async function liveRuns(
  ctx: QueryCtx,
  account: string,
  statuses: ReadonlyArray<string>,
) {
  const found: Array<{ repo: Doc<'repos'>; doc: Doc<'pipelineRuns'> }> = []
  const repos = await ctx.db
    .query('repos')
    .withIndex('by_owner_and_created_and_publicId', (q) =>
      q.eq('owner', account),
    )
    .take(500)
  for (const repo of repos)
    for (const status of statuses)
      for (const doc of await ctx.db
        .query('pipelineRuns')
        .withIndex('by_repoId_and_status_and_started', (q) =>
          q.eq('repoId', repo._id).eq('status', status),
        )
        .take(200))
        found.push({ repo, doc })
  return found
}

async function heldBy(ctx: QueryCtx, r: Doc<'runners'>) {
  const held: Array<{
    repo: Doc<'repos'>
    doc: Doc<'pipelineRuns'>
    run: PipelineRun
    ji: number
  }> = []
  for (const { repo, doc } of await liveRuns(ctx, r.account, [
    'running',
    'waiting',
  ])) {
    const run = await load(ctx, doc)
    for (const [ji, j] of run.jobs.entries())
      if (j.runnerId === r.publicId && holds(j.status))
        held.push({ repo, doc, run, ji })
  }
  return held
}

async function present(
  ctx: QueryCtx,
  r: Doc<'runners'>,
  secret: string | null = null,
  now = Date.now(),
) {
  const current = (await heldBy(ctx, r)).length
  const l = await like(ctx, r)
  return {
    object: 'runner' as const,
    id: r.publicId,
    name: r.name,
    account: r.account,
    kind: r.kind,
    provider: r.provider,
    labels: [...r.labels],
    repos: l.repos,
    concurrency: r.concurrency,
    status: runnerStatus(l, current, now),
    current_jobs: current,
    last_seen_at: l.lastSeen === null ? null : iso(l.lastSeen),
    created_at: iso(r.created),
    created_by: r.createdBy,
    secret,
    url: `${urls().api}/runners/${r.publicId}`,
    html_url: `${urls().html}/settings?section=runners&runner=${r.publicId}`,
  }
}

async function manages(ctx: QueryCtx, account: string, p: Actor) {
  const acct = await accountByHandle(ctx, account)
  if (!acct) return false
  if (acct.kind === 'person') return account === p.handle
  const role = await roleIn(ctx, acct, p.handle)
  return role === 'owner' || role === 'admin'
}

async function runnerFor(ctx: QueryCtx, p: Actor, id: string, manage = true) {
  const r = await ctx.db
    .query('runners')
    .withIndex('by_publicId', (q) => q.eq('publicId', id))
    .unique()
  if (!r || p.runnerId || !(await isMember(ctx, r.account, p.handle)))
    fail('not_found', `No runner ${id}.`)
  if (manage && !(await manages(ctx, r.account, p)))
    fail(
      'forbidden',
      `Only an owner or admin of ${r.account} can change its runners.`,
    )
  return r
}

function nameTaken(account: string, name: string): never {
  fail('invalid_request', `${account} already has a runner named ${name}.`, {
    errors: [
      {
        pointer: '/body/name',
        code: 'taken',
        message: 'Runner names are unique in an account.',
      },
    ],
  })
}

async function sameName(ctx: QueryCtx, account: string, name: string) {
  for (const r of await ctx.db
    .query('runners')
    .withIndex('by_account_and_name', (q) => q.eq('account', account))
    .take(500))
    if (r.status !== 'disabled' && r.name.toLowerCase() === name.toLowerCase())
      return r
  return null
}

async function checkFields(
  ctx: QueryCtx,
  account: string,
  p: Actor,
  a: { labels?: Array<string>; repos?: Array<string> | null },
) {
  const labels = a.labels ? normalizeLabels(a.labels) : undefined
  const bad = labels?.find((l) => !labelShape.test(l))
  if (labels && (bad !== undefined || labels.length > MAX_LABELS))
    fail(
      'invalid_request',
      'A label is lowercase letters, digits and . _ : + -, up to 50 of them.',
      {
        errors: [
          {
            pointer: '/body/labels',
            code: 'invalid_label',
            message: bad
              ? `Not a label: ${bad}`
              : `At most ${MAX_LABELS} labels.`,
          },
        ],
      },
    )
  let names: Array<string> | null | undefined = undefined
  if (a.repos !== undefined) {
    if (a.repos === null) names = null
    else {
      const set = new Set<string>()
      for (const full of a.repos) {
        const [o, n] = full.split('/')
        const repo = await resolve(ctx, o, n, p)
        if (repo.owner.toLowerCase() !== account.toLowerCase())
          fail('invalid_request', `${full} does not belong to ${account}.`, {
            errors: [
              {
                pointer: '/body/repos',
                code: 'other_account',
                message: 'A runner serves repositories of its own account.',
              },
            ],
          })
        set.add(`${repo.owner}/${repo.name}`.toLowerCase())
      }
      names = [...set]
    }
  }
  return { labels, names }
}

export const create = mutation({
  args: {
    name: v.string(),
    account: v.optional(v.string()),
    kind: v.optional(v.union(v.literal('self-hosted'), v.literal('hosted'))),
    provider: v.optional(v.union(v.null(), v.string())),
    labels: v.optional(v.array(v.string())),
    repos: v.optional(v.union(v.null(), v.array(v.string()))),
    concurrency: v.optional(v.number()),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx, 'Sign in to register a runner.')
    const account = a.account ?? p.actingAs
    if (
      !(await accountByHandle(ctx, account)) ||
      !(await isMember(ctx, account, p.handle))
    )
      fail('not_found', `No account ${account}.`)
    if (!(await manages(ctx, account, p)))
      fail(
        'forbidden',
        `Only an owner or admin of ${account} can register its runners.`,
      )
    if (p.repos)
      fail(
        'forbidden',
        'A token limited to repositories cannot register runners.',
      )
    if (await sameName(ctx, account, a.name)) nameTaken(account, a.name)
    const live = (
      await ctx.db
        .query('runners')
        .withIndex('by_account_and_name', (q) => q.eq('account', account))
        .take(MAX_RUNNERS * 4)
    ).filter((r) => r.status !== 'disabled')
    if (live.length >= MAX_RUNNERS)
      fail('limit_reached', `An account can have ${MAX_RUNNERS} runners.`)
    const { labels, names } = await checkFields(ctx, account, p, a)
    const at = Date.now()
    const publicId = newId('runner', at)
    const { record, secret } = await mintToken(ctx, {
      name: `runner ${a.name}`,
      kind: 'runner',
      handle: account,
      actingAs: account,
      scopes: [...runnerScopes],
      repos: names ?? null,
      runnerId: publicId,
      device: a.name,
      audience: ['api'],
      ttlMs: RUNNER_TTL_MS,
    })
    const id = await ctx.db.insert('runners', {
      publicId,
      account,
      name: a.name,
      kind: a.kind ?? 'self-hosted',
      provider: a.kind === 'hosted' ? (a.provider ?? null) : null,
      labels: labels ?? [],
      repos: names ? await toRefs(ctx, names) : null,
      concurrency: Math.min(a.concurrency ?? 1, MAX_CONCURRENCY),
      status: 'active',
      createdBy: p.handle,
      created: at,
      tokenId: record.id,
    })
    const doc = (await ctx.db.get('runners', id))!
    return finish(a.dry, await present(ctx, doc, a.dry ? null : secret))
  },
})

export const list = query({
  args: { account: v.optional(v.string()), now: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    if (!p) fail('unauthenticated', 'Sign in to list runners.')
    const account = a.account ?? p.actingAs
    if (p.runnerId || !(await isMember(ctx, account, p.handle)))
      fail('not_found', `No account ${account}.`)
    const docs = await ctx.db
      .query('runners')
      .withIndex('by_account_and_name', (q) => q.eq('account', account))
      .take(500)
    docs.sort((x, y) => y.created - x.created)
    const items = []
    for (const d of docs) items.push(await present(ctx, d, null, a.now))
    return out(items)
  },
})

export const get = query({
  args: { id: v.string(), now: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    if (!p) fail('not_found', `No runner ${a.id}.`)
    return out(
      await present(ctx, await runnerFor(ctx, p, a.id, false), null, a.now),
    )
  },
})

export const update = mutation({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    repos: v.optional(v.union(v.null(), v.array(v.string()))),
    concurrency: v.optional(v.number()),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const r = await runnerFor(ctx, p, a.id)
    if (r.status === 'disabled')
      fail('invalid_state', `Runner ${r.name} was revoked; register a new one.`)
    const { labels, names } = await checkFields(ctx, r.account, p, a)
    if (a.name && a.name.toLowerCase() !== r.name.toLowerCase()) {
      if (await sameName(ctx, r.account, a.name)) nameTaken(r.account, a.name)
    }
    const repos =
      names === undefined
        ? r.repos
        : names === null
          ? null
          : await toRefs(ctx, names)
    await ctx.db.patch('runners', r._id, {
      ...(a.name ? { name: a.name } : {}),
      ...(labels ? { labels } : {}),
      repos,
      ...(a.concurrency !== undefined
        ? { concurrency: Math.min(a.concurrency, MAX_CONCURRENCY) }
        : {}),
    })
    if (names !== undefined) {
      const t = await ctx.db
        .query('tokens')
        .withIndex('by_publicId', (q) => q.eq('publicId', r.tokenId))
        .unique()
      if (t)
        await ctx.db.patch('tokens', t._id, {
          repos: names === null ? null : await toRefs(ctx, names),
        })
    }
    return finish(
      a.dry,
      await present(ctx, (await ctx.db.get('runners', r._id))!),
    )
  },
})

export const remove = mutation({
  args: { id: v.string(), dry: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const r = await runnerFor(ctx, p, a.id)
    if (r.status !== 'disabled') {
      await ctx.db.patch('runners', r._id, { status: 'disabled' })
      await revokeToken(ctx, r.tokenId)
    }
    return finish(
      a.dry,
      await present(ctx, (await ctx.db.get('runners', r._id))!),
    )
  },
})

async function runnerOf(ctx: QueryCtx, signed?: Actor) {
  const p = signed ?? (await signedIn(ctx))
  const r = p.runnerId
    ? await ctx.db
        .query('runners')
        .withIndex('by_publicId', (q) => q.eq('publicId', p.runnerId!))
        .unique()
    : null
  if (!r || r.status === 'disabled')
    fail(
      'forbidden',
      'Only a registered runner can do this, with its own token.',
      {
        hint: 'Register one with POST /v1/runners and use the secret it answers with.',
      },
    )
  return { p, r }
}

async function seen(ctx: MutationCtx, r: Doc<'runners'>, at: number) {
  const s = await ctx.db
    .query('runnerSeen')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', r._id))
    .unique()
  if (s) await ctx.db.patch('runnerSeen', s._id, { at })
  else await ctx.db.insert('runnerSeen', { runnerId: r._id, at })
}

export const heartbeat = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const { r } = await runnerOf(ctx, await signedIn(ctx))
    const now = Date.now()
    await requeueExpired(ctx, 200, (repo) => repo.owner === r.account)
    await seen(ctx, r, now)
    for (const { repo, doc, run, ji } of await heldBy(ctx, r))
      if (run.jobs[ji].status === 'running') {
        run.jobs[ji].lease = now + LEASE_MS
        run.version++
        await save(ctx, repo, doc, run)
      }
    return out(await present(ctx, r))
  },
})

export const claim = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const { r } = await runnerOf(ctx, await signedIn(ctx))
    const now = Date.now()
    await requeueExpired(ctx, 200, (repo) => repo.owner === r.account)
    await seen(ctx, r, now)
    if ((await heldBy(ctx, r)).length >= r.concurrency) return out(null)
    const me = await like(ctx, r)
    const offered = (await liveRuns(ctx, r.account, ['queued', 'running']))
      .filter(({ repo }) => mayServe(me, repo.owner, repo.name))
      .sort((x, y) => x.doc.started - y.doc.started)
    for (const { repo, doc } of offered) {
      const run = await load(ctx, doc)
      if (run.runsOnPending) continue
      const ji = run.jobs.findIndex(
        (j) => j.status === 'queued' && labelsMatch(j.runsOn ?? [], r.labels),
      )
      if (ji < 0) continue
      const j = run.jobs[ji]
      j.status = 'running'
      j.runner = r.name
      j.runnerId = r.publicId
      j.lease = now + LEASE_MS
      if (run.status === 'queued') run.status = 'running'
      run.version++
      await save(ctx, repo, doc, run)
      return out(claimedJob(repo, run, ji))
    }
    return out(null)
  },
})

export const report = mutation({
  args: {
    repo: v.string(),
    run: v.number(),
    job: v.number(),
    step: v.number(),
    status: v.union(
      v.literal('running'),
      v.literal('success'),
      v.literal('failure'),
      v.literal('skipped'),
    ),
    lines: v.optional(
      v.array(
        v.object({
          text: v.string(),
          level: v.optional(v.union(v.null(), v.string())),
        }),
      ),
    ),
    duration_ms: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const { p, r } = await runnerOf(ctx)
    const [o, n] = a.repo.split('/')
    const repo = await resolve(ctx, o, n, p)
    if (!mayServe(await like(ctx, r), repo.owner, repo.name))
      fail('not_found', `No repository ${a.repo}.`)
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.run)
    const run = await load(ctx, doc)
    const j = run.jobs.at(a.job - 1)
    if (!j || a.job < 1) fail('not_found', `Run ${a.run} has no job ${a.job}.`)
    if (j.runnerId !== r.publicId)
      fail('forbidden', `Job ${a.job} of run ${a.run} is not this runner's.`, {
        hint: 'A runner reports only the jobs it claimed. Its lease may have run out.',
      })
    await seen(ctx, r, Date.now())
    const after = await applyReport(ctx, repo, doc, { ...a, n: a.run })
    return out(await shown(ctx, repo, doc, after))
  },
})

export const jobs = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    if (!p) fail('not_found', `No runner ${a.id}.`)
    let r: Doc<'runners'>
    if (p.runnerId) {
      r = (await runnerOf(ctx)).r
      if (r.publicId !== a.id) fail('not_found', `No runner ${a.id}.`)
    } else r = await runnerFor(ctx, p, a.id, false)
    return out(
      (await heldBy(ctx, r)).map(({ repo, run, ji }) => ({
        object: 'runner_job' as const,
        repo: `${repo.owner}/${repo.name}`,
        run: run.number,
        job: ji + 1,
        name: run.jobs[ji].name,
        status: run.jobs[ji].status,
        lease_expires_at: run.jobs[ji].lease ? iso(run.jobs[ji].lease) : null,
        url: `${repoUrl(repo)}/pipelines/${run.number}/jobs/${ji + 1}`,
      })),
    )
  },
})

export const wait = mutation({
  args: {
    repo: v.string(),
    run: v.number(),
    job: v.number(),
    step: v.number(),
    kind: v.union(
      v.literal('person'),
      v.literal('agent'),
      v.literal('approval'),
    ),
    reason: v.string(),
    target: v.optional(v.union(v.null(), v.string())),
    expires_at: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const { p, r } = await runnerOf(ctx, await signedIn(ctx))
    const [o, n] = a.repo.split('/')
    const repo = await resolve(ctx, o, n, p)
    if (!mayServe(await like(ctx, r), repo.owner, repo.name))
      fail('not_found', `No repository ${a.repo}.`)
    await expireDue(ctx, repo)
    const doc = await runOf(ctx, repo, a.run)
    const held = (await load(ctx, doc)).jobs.at(a.job - 1)
    if (!held || a.job < 1)
      fail('not_found', `Run ${a.run} has no job ${a.job}.`)
    if (held.runnerId !== r.publicId)
      fail('forbidden', `Job ${a.job} of run ${a.run} is not this runner's.`, {
        hint: 'A runner pauses only the jobs it claimed. Its lease may have run out.',
      })
    await seen(ctx, r, Date.now())
    const run = await applyWait(ctx, repo, doc, a, p.handle)
    return out(await shown(ctx, repo, doc, run))
  },
})
