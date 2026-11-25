import { newId, seededId } from '@cobaltforge/api/ids'
import type { EventRecord } from '@cobaltforge/api/events'
import { accountByHandle } from './access'
import { now } from './time'
import { internal } from '../_generated/api'
import { track, tracked } from './stats'
import { actorOf } from './actor'
import type { Via } from './actor'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export type ActorRef = { id: string; handle: string }

export async function actorFor(
  ctx: MutationCtx,
  handle: string,
): Promise<ActorRef> {
  const account = await accountByHandle(ctx, handle)
  if (account) return { id: account.publicId, handle }
  const own = await actorRow(ctx, handle)
  if (own) return { id: own.publicId, handle }
  const publicId = seededId('account', now(), handle)
  await ctx.db.insert('actors', { key: handle, publicId, handle })
  return { id: publicId, handle }
}

export async function viaOf(ctx: QueryCtx): Promise<Via> {
  return (await actorOf(ctx))?.via ?? { machine: null, tool: null, model: null }
}

function actorRow(ctx: QueryCtx, key: string) {
  return ctx.db
    .query('actors')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique()
}

export async function counters(ctx: QueryCtx, repo: Doc<'repos'>) {
  const c = await ctx.db
    .query('repoCounters')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
  if (!c) throw new Error(`repository ${repo.publicId} has no counters`)
  return c
}

export type CounterField = 'changeRev' | 'issueRev' | 'labelRev' | 'policyRev'

export async function emit(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  type: string,
  by: ActorRef,
  subject: { object: string; id: string; number: number | null },
  changes: Array<string>,
  data: unknown,
  bump: Array<CounterField> = [],
  touch = true,
  via?: Via,
): Promise<EventRecord> {
  const at = now()
  const c = await counters(ctx, repo)
  const patch: Partial<Doc<'repoCounters'>> = { seq: c.seq + 1, rev: c.rev + 1 }
  for (const f of bump) patch[f] = c[f] + 1
  await ctx.db.patch('repoCounters', c._id, patch)
  if (touch) await ctx.db.patch('repos', repo._id, { updated: at })
  const full = `${repo.owner}/${repo.name}`
  const record: EventRecord = {
    object: 'event',
    id: newId('event', at),
    sequence: 0,
    type,
    created_at: new Date(at).toISOString(),
    repo: full,
    repo_id: repo.publicId,
    actor: { object: 'actor', id: by.id, handle: by.handle },
    via: via ?? (await viaOf(ctx)),
    subject,
    changes,
    data: (data ?? null) as EventRecord['data'],
  }
  const state = (data as { state?: unknown } | null)?.state
  if (
    subject.number !== null &&
    (subject.object === 'change' || subject.object === 'issue') &&
    typeof state === 'string' &&
    /^(change\.(opened|updated|landed|abandoned)|issue\.(created|updated|closed))$/.test(
      type,
    )
  )
    await ctx.db.insert('stateChanges', {
      repoId: repo._id,
      subject: `${subject.object}:${subject.number}`,
      to: state,
      at,
      eventId: record.id,
      actor: { id: by.id, handle: by.handle },
      via: record.via ?? undefined,
    })
  if (tracked(type))
    await track(ctx, type, by.handle, {
      repo_id: repo.publicId,
      visibility: repo.visibility,
    })
  await ctx.db.insert('forgeEvents', {
    stream: repo.publicId,
    seq: c.seq + 1,
    type,
    repo: full,
    repoId: repo.publicId,
    created: at,
    json: JSON.stringify(record),
    sequence: null,
  })
  await ctx.scheduler.runAfter(0, internal.forge.events.sequence, {})
  return record
}

export async function externalActorFor(
  ctx: MutationCtx,
  provider: string,
  externalId: string,
  login: string,
): Promise<ActorRef> {
  const linked = await ctx.db
    .query('links')
    .withIndex('by_host_and_login', (q) =>
      q.eq('host', provider).eq('login', login),
    )
    .take(5)
  for (const l of linked)
    if (l.verified) {
      const account = await accountByHandle(ctx, l.handle)
      if (account) return { id: account.publicId, handle: account.handle }
    }
  const key = `${provider}:${externalId}`
  const handle = `${login}@${provider}`
  const own = await actorRow(ctx, key)
  if (own) {
    if (own.handle !== handle) await ctx.db.patch('actors', own._id, { handle })
    return { id: own.publicId, handle }
  }
  const publicId = seededId('account', now(), key)
  await ctx.db.insert('actors', { key, publicId, handle })
  return { id: publicId, handle }
}

export async function reserveNumber(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  n: number,
) {
  const c = await counters(ctx, repo)
  if (c.nextNumber <= n)
    await ctx.db.patch('repoCounters', c._id, { nextNumber: n + 1 })
}
