import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery, query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { system } from '../lib/actor'
import { out } from '../lib/errors'
import { ALL, READY, add, metrics, ready, total } from '../lib/stats'
import { monthOf } from '../lib/time'
import type { Metric } from '../lib/stats'
import type { MutationCtx, QueryCtx } from '../_generated/server'

const DAY_MINUTES = 1_440
const KEEP_MINUTES = 120
const KEEP_DAYS = 91

const bucket = v.object({
  area: v.string(),
  minute: v.number(),
  requests: v.number(),
  errors: v.number(),
  hist: v.array(v.number()),
})

export const record = mutation({
  args: { buckets: v.array(bucket) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await system(ctx)
    const days = new Map<
      string,
      { area: string; day: number; requests: number; errors: number }
    >()
    for (const b of args.buckets.slice(0, 2_000)) {
      const have = await ctx.db
        .query('healthMinutes')
        .withIndex('by_area_and_minute', (q) =>
          q.eq('area', b.area).eq('minute', b.minute),
        )
        .unique()
      if (have)
        await ctx.db.patch('healthMinutes', have._id, {
          requests: have.requests + b.requests,
          errors: have.errors + b.errors,
          hist: b.hist.map((n, i) => n + (have.hist[i] ?? 0)),
        })
      else await ctx.db.insert('healthMinutes', b)
      const day = Math.floor(b.minute / DAY_MINUTES)
      const k = `${b.area}:${day}`
      const d = days.get(k) ?? { area: b.area, day, requests: 0, errors: 0 }
      d.requests += b.requests
      d.errors += b.errors
      days.set(k, d)
    }
    for (const d of days.values()) {
      const have = await ctx.db
        .query('healthDays')
        .withIndex('by_area_and_day', (q) =>
          q.eq('area', d.area).eq('day', d.day),
        )
        .unique()
      if (have)
        await ctx.db.patch('healthDays', have._id, {
          requests: have.requests + d.requests,
          errors: have.errors + d.errors,
        })
      else await ctx.db.insert('healthDays', d)
    }
    return null
  },
})

export const report = query({
  args: { areas: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    await system(ctx)
    const now = Date.now()
    const minute = Math.floor(now / 60_000)
    const today = Math.floor(minute / DAY_MINUTES)
    const areas: Record<
      string,
      {
        days: Array<{ day: number; requests: number; errors: number }>
        minutes: Array<{
          minute: number
          requests: number
          errors: number
          hist: Array<number>
        }>
      }
    > = {}
    for (const area of args.areas.slice(0, 20)) {
      const days = await ctx.db
        .query('healthDays')
        .withIndex('by_area_and_day', (q) =>
          q.eq('area', area).gt('day', today - KEEP_DAYS),
        )
        .take(KEEP_DAYS)
      const minutes = await ctx.db
        .query('healthMinutes')
        .withIndex('by_area_and_minute', (q) =>
          q.eq('area', area).gt('minute', minute - 60),
        )
        .take(61)
      areas[area] = {
        days: days.map((d) => ({
          day: d.day,
          requests: d.requests,
          errors: d.errors,
        })),
        minutes: minutes.map((m) => ({
          minute: m.minute,
          requests: m.requests,
          errors: m.errors,
          hist: m.hist,
        })),
      }
    }
    return out({ areas })
  },
})

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const minute = Math.floor(Date.now() / 60_000)
    const oldMinutes = await ctx.db
      .query('healthMinutes')
      .withIndex('by_minute', (q) => q.lt('minute', minute - KEEP_MINUTES))
      .take(500)
    for (const m of oldMinutes) await ctx.db.delete('healthMinutes', m._id)
    const oldDays = await ctx.db
      .query('healthDays')
      .withIndex('by_day', (q) =>
        q.lt('day', Math.floor(minute / DAY_MINUTES) - KEEP_DAYS),
      )
      .take(500)
    for (const d of oldDays) await ctx.db.delete('healthDays', d._id)
    if (oldMinutes.length === 500 || oldDays.length === 500)
      await ctx.scheduler.runAfter(0, internal.forge.health.sweep, {})
    return null
  },
})

type Counts = {
  accounts: number
  repositories: number
  changes: number
  issues: number
}

export async function countsOf(ctx: QueryCtx | MutationCtx): Promise<Counts> {
  const of = async (
    m: Metric,
    table: 'accounts' | 'repos' | 'changes' | 'issues',
  ) =>
    (await ready(ctx, m))
      ? await total(ctx, m)
      : (await ctx.db.query(table).take(10_000)).length
  const repos = (await ready(ctx, 'repo.created'))
    ? (await total(ctx, 'repo.created')) - (await total(ctx, 'repo.deleted'))
    : await of('repo.created', 'repos')
  return {
    accounts: await of('account.created', 'accounts'),
    repositories: repos,
    changes: await of('change.opened', 'changes'),
    issues: await of('issue.created', 'issues'),
  }
}

export const tallies = internalQuery({
  args: { period: v.optional(v.string()) },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, { period }) => {
    const res: Record<string, number> = {}
    for (const m of metrics) res[m] = await total(ctx, m, period ?? ALL)
    return res
  },
})

type Row = { _creationTime: number; created?: number; deleted?: number }
const STEPS: ReadonlyArray<{
  table: 'accounts' | 'repos' | 'deletedRepos' | 'changes' | 'issues' | 'pushes'
  out: ReadonlyArray<{ metric: Metric; at: ((r: Row) => number) | null }>
}> = [
  {
    table: 'accounts',
    out: [
      { metric: 'account.created', at: (r) => r.created ?? r._creationTime },
    ],
  },
  {
    table: 'deletedRepos',
    out: [
      { metric: 'repo.created', at: null },
      { metric: 'repo.deleted', at: (r) => r.deleted ?? r._creationTime },
    ],
  },
  {
    table: 'repos',
    out: [{ metric: 'repo.created', at: (r) => r.created ?? r._creationTime }],
  },
  {
    table: 'changes',
    out: [{ metric: 'change.opened', at: (r) => r.created ?? r._creationTime }],
  },
  {
    table: 'issues',
    out: [{ metric: 'issue.created', at: (r) => r.created ?? r._creationTime }],
  },
  {
    table: 'pushes',
    out: [{ metric: 'repository.pushed', at: (r) => r._creationTime }],
  },
]
const lastStepOf = (m: Metric) => {
  let last = -1
  STEPS.forEach((s, i) => {
    if (s.out.some((o) => o.metric === m)) last = i
  })
  return last
}

export const startSeed = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const done = new Set<Metric>()
    for (const m of metrics) if (await ready(ctx, m)) done.add(m)
    if (done.size === metrics.length) return null
    const row = await ctx.db.query('tallySeed').first()
    const now = Date.now()
    if (row?.pass && now - row.pass.moved < 5 * 60_000) return null
    for (const m of metrics) {
      if (done.has(m)) continue
      for (const t of await ctx.db
        .query('tallies')
        .withIndex('by_metric_and_period_and_shard', (q) => q.eq('metric', m))
        .take(4_000))
        await ctx.db.delete('tallies', t._id)
    }
    for (const old of await ctx.db.query('statusCounts').take(10))
      await ctx.db.delete('statusCounts', old._id)
    const pass = { step: 0, cursor: null, moved: now }
    if (row) await ctx.db.patch('tallySeed', row._id, { pass })
    else await ctx.db.insert('tallySeed', { pass })
    await ctx.scheduler.runAfter(0, internal.forge.health.seedStep, {})
    return null
  },
})

export const seedStep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await ctx.db.query('tallySeed').first()
    if (!row?.pass) return null
    const { step, cursor } = row.pass
    const s = STEPS[step]
    const page = await ctx.db
      .query(s.table)
      .paginate({ cursor, numItems: 2_000 })
    const done = new Set<Metric>()
    for (const o of s.out) if (await ready(ctx, o.metric)) done.add(o.metric)
    const sums = new Map<string, number>()
    const bump = (k: string) => sums.set(k, (sums.get(k) ?? 0) + 1)
    for (const r of page.page as Array<Row>)
      for (const o of s.out) {
        if (done.has(o.metric)) continue
        bump(`${o.metric}|${ALL}`)
        if (o.at) bump(`${o.metric}|${monthOf(o.at(r))}`)
      }
    for (const [k, n] of sums) {
      const [metric, period] = k.split('|') as [Metric, string]
      await add(ctx, metric, period, n, 0)
    }
    if (!page.isDone) {
      await ctx.db.patch('tallySeed', row._id, {
        pass: { step, cursor: page.continueCursor, moved: Date.now() },
      })
      await ctx.scheduler.runAfter(0, internal.forge.health.seedStep, {})
      return null
    }
    for (const o of s.out)
      if (lastStepOf(o.metric) === step && !done.has(o.metric)) {
        done.add(o.metric)
        await ctx.db.insert('tallies', {
          metric: o.metric,
          period: READY,
          shard: 0,
          value: 1,
        })
      }
    const next = step + 1
    if (next === STEPS.length) {
      await ctx.db.patch('tallySeed', row._id, { pass: undefined })
      return null
    }
    await ctx.db.patch('tallySeed', row._id, {
      pass: { step: next, cursor: null, moved: Date.now() },
    })
    await ctx.scheduler.runAfter(0, internal.forge.health.seedStep, {})
    return null
  },
})
