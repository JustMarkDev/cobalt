import { env } from '../_generated/server'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export const metrics = [
  'account.created',
  'repo.created',
  'repo.deleted',
  'change.opened',
  'issue.created',
  'repository.pushed',
] as const
export type Metric = (typeof metrics)[number]

export const SHARDS = 4
export const ALL = 'all'

export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7)

export const READY = 'ready'

export async function ready(ctx: QueryCtx, metric: Metric) {
  const row = await ctx.db
    .query('tallies')
    .withIndex('by_metric_and_period_and_shard', (q) =>
      q.eq('metric', metric).eq('period', READY).eq('shard', 0),
    )
    .unique()
  return row !== null
}

export async function add(
  ctx: MutationCtx,
  metric: Metric,
  period: string,
  by: number,
  shard = Math.floor(Math.random() * SHARDS),
) {
  const row = await ctx.db
    .query('tallies')
    .withIndex('by_metric_and_period_and_shard', (q) =>
      q.eq('metric', metric).eq('period', period).eq('shard', shard),
    )
    .unique()
  if (row) await ctx.db.patch('tallies', row._id, { value: row.value + by })
  else await ctx.db.insert('tallies', { metric, period, shard, value: by })
}

export async function tally(ctx: MutationCtx, metric: Metric, at = Date.now()) {
  if (!(await ready(ctx, metric))) return
  await add(ctx, metric, ALL, 1)
  await add(ctx, metric, monthOf(at), 1)
}

export async function forgetTallies(ctx: MutationCtx) {
  for (const t of await ctx.db.query('tallies').take(8_000))
    await ctx.db.delete('tallies', t._id)
  for (const s of await ctx.db.query('tallySeed').take(10))
    await ctx.db.delete('tallySeed', s._id)
}

export async function total(ctx: QueryCtx, metric: Metric, period = ALL) {
  const rows = await ctx.db
    .query('tallies')
    .withIndex('by_metric_and_period_and_shard', (q) =>
      q.eq('metric', metric).eq('period', period),
    )
    .take(SHARDS * 4)
  return rows.reduce((n, r) => n + r.value, 0)
}

const TRACKED = new Set([
  'repo.deleted',
  'repository.pushed',
  'change.opened',
  'change.landed',
  'change.abandoned',
  'change.reviewed',
  'issue.created',
  'issue.closed',
  'release.published',
  'run.started',
  'run.finished',
])

export function tracked(type: string) {
  return TRACKED.has(type)
}

export async function track(
  ctx: MutationCtx,
  event: string,
  who: string,
  props: Record<string, string | number | boolean | null> = {},
) {
  if (!env.POSTHOG_KEY) return
  await ctx.db.insert('analyticsOutbox', {
    event,
    who,
    at: Date.now(),
    props: JSON.stringify(props),
  })
}
