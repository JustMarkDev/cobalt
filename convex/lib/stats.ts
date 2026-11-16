import { env } from '../_generated/server'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/**
 * What the forge adds up about itself: how many accounts, repositories,
 * changes, issues and pushes there are, in all and per calendar month (UTC).
 *
 * Every number is a tally kept when the row is written, in the same
 * transaction, so reading one costs a few documents however large the tables
 * grow. Tallies only go up: a deleted repository is a `repo.deleted`, and the
 * repositories that exist are `repo.created` less `repo.deleted`.
 *
 * Each tally is split over a few shards, so writes that happen at the same
 * moment rarely touch the same document. A reader adds the shards up.
 *
 * A deployment that had rows before tallies existed fills them in once
 * (`forge/health.ts`, `seedStep`). Until a metric is filled in, writes leave it
 * alone, so no row is counted twice.
 */
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

/** The calendar month a moment falls in, `2026-11`. */
export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7)

/** The period of the row that marks a metric as filled in. */
export const READY = 'ready'

/**
 * Whether a metric has been filled in for the rows that came before tallies:
 * one indexed read of a row nothing else writes, so it never conflicts.
 */
export async function ready(ctx: QueryCtx, metric: Metric) {
  const row = await ctx.db
    .query('tallies')
    .withIndex('by_metric_and_period_and_shard', (q) =>
      q.eq('metric', metric).eq('period', READY).eq('shard', 0),
    )
    .unique()
  return row !== null
}

/** Adds to one tally period, on the shard given. */
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

/**
 * One more of something, now: the all-time tally and this month's. Call it in
 * the mutation that writes the row.
 */
export async function tally(ctx: MutationCtx, metric: Metric, at = Date.now()) {
  if (!(await ready(ctx, metric))) return
  await add(ctx, metric, ALL, 1)
  await add(ctx, metric, monthOf(at), 1)
}

/**
 * Drops every tally, so the next fill counts all rows again. For loading many
 * rows at once (the sample), where counting each would cost a read apiece.
 */
export async function forgetTallies(ctx: MutationCtx) {
  for (const t of await ctx.db.query('tallies').take(8_000))
    await ctx.db.delete('tallies', t._id)
  for (const s of await ctx.db.query('tallySeed').take(10))
    await ctx.db.delete('tallySeed', s._id)
}

/** A tally's value for one period (`all` or a month). */
export async function total(ctx: QueryCtx, metric: Metric, period = ALL) {
  const rows = await ctx.db
    .query('tallies')
    .withIndex('by_metric_and_period_and_shard', (q) =>
      q.eq('metric', metric).eq('period', period),
    )
    .take(SHARDS * 4)
  return rows.reduce((n, r) => n + r.value, 0)
}

// ----- product events -------------------------------------------------------

/**
 * What goes to product analytics (PostHog). Events are queued in the same
 * transaction as the write, so only what committed is sent, and a cron sends
 * the queue in batches (`analytics.ts`). Without POSTHOG_KEY nothing is
 * queued.
 *
 * Only these event types are sent; the rest of the event log is too fine to
 * be worth paying for.
 */
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

/**
 * Queues one product event. `who` is the actor's handle, or a system name.
 * Properties must not carry anything private: no titles, bodies or code.
 */
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
