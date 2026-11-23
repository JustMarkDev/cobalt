import { v } from 'convex/values'
import { query } from '../_generated/server'
import { actorOf, signedIn, system } from '../lib/actor'
import {
  accountByHandle,
  canRead,
  canWrite,
  isMember,
  resolve,
} from '../lib/access'
import { fail, out } from '../lib/errors'
import { counters } from '../lib/events'
import { presentRepo } from '../lib/present'
import { countsOf } from './health'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { Actor } from '../lib/actor'

/**
 * The facts insights, the dashboard and the status page add up, with who
 * may see them decided here. The API server adds what it holds itself (git
 * history, mirrors, its own request health) and does the arithmetic.
 */

const DAY = 86_400_000

async function downloads(
  ctx: QueryCtx,
  repos: Array<Doc<'repos'>>,
  at: number,
) {
  let total = 0
  const days: Array<{ day: number; n: number }> = []
  for (const r of repos) {
    for (const rel of await ctx.db
      .query('releases')
      .withIndex('by_repoId_and_published', (q) => q.eq('repoId', r._id))
      .take(1000)) {
      total += (
        JSON.parse(rel.json) as { assets: Array<{ downloads: number }> }
      ).assets.reduce((n, x) => n + x.downloads, 0)
      for (const s of await ctx.db
        .query('downloads')
        .withIndex('by_releaseId_and_asset_and_shard', (q) =>
          q.eq('releaseId', rel._id),
        )
        .take(500))
        total += s.n
    }
    for (const d of await ctx.db
      .query('downloadDays')
      .withIndex('by_repoId_and_day', (q) =>
        q.eq('repoId', r._id).gt('day', Math.floor(at / DAY) - 61),
      )
      .take(100))
      days.push({ day: d.day, n: d.n })
  }
  return { total, days }
}

async function countBy<T extends string>(
  ctx: QueryCtx,
  table: 'changes' | 'issues',
  repo: Doc<'repos'>,
) {
  const counts: Record<string, number> = {}
  for await (const x of ctx.db
    .query(table)
    .withIndex('by_repoId_and_number', (q) => q.eq('repoId', repo._id)))
    counts[x.state] = (counts[x.state] ?? 0) + 1
  return counts as Record<T, number>
}

export const repoFacts = query({
  args: {
    owner: v.string(),
    name: v.string(),
    at: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const r = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    // Patch sets by the model their tool declared, over the newest changes:
    // the repository's own record of which models' work it took.
    const models = new Map<string | null, number>()
    for (const c of await ctx.db
      .query('changes')
      .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id))
      .order('desc')
      .take(200))
      for (const part of await ctx.db
        .query('changeParts')
        .withIndex('by_changeId_and_kind_and_seq', (q) =>
          q.eq('changeId', c._id).eq('kind', 'patchSet'),
        )
        .take(100)) {
        const model =
          (JSON.parse(part.json) as { via?: { model?: string | null } }).via
            ?.model ?? null
        models.set(model, (models.get(model) ?? 0) + 1)
      }
    const byModel = [...models]
      .map(([model, count]) => ({ model, count }))
      .sort(
        (x, y) =>
          y.count - x.count || String(x.model).localeCompare(String(y.model)),
      )
    const shown = await presentRepo(ctx, r, a.at)
    return out({
      repo: `${r.owner}/${r.name}`,
      byModel,
      downloads: await downloads(ctx, [r], a.at),
      stars: { total: r.stars, today: shown.stars_today },
      issues: await countBy(ctx, 'issues', r),
      changes: await countBy(ctx, 'changes', r),
    })
  },
})

export const repoVersion = query({
  args: {
    owner: v.string(),
    name: v.string(),
    at: v.number(),
    access: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const r = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const c = await counters(ctx, r)
    let d = 0
    for (const x of await ctx.db
      .query('downloadDays')
      .withIndex('by_repoId_and_day', (q) => q.eq('repoId', r._id))
      .take(1000))
      d += x.n
    return out(
      `${r.publicId}.ins${c.rev}.${c.changeRev}.${c.issueRev}.${d}.${Math.floor(a.at / DAY)}.${a.access}`,
    )
  },
})

type Pipeline = {
  number: number
  workflow: string
  title: string
  branch: string
  status: string
  actor: string
  started: number
  jobs: Array<{ status: string }>
}

export async function pipelines(ctx: QueryCtx, r: Doc<'repos'>) {
  return (
    await ctx.db
      .query('pipelineRuns')
      .withIndex('by_repoId_and_started', (q) => q.eq('repoId', r._id))
      .order('desc')
      .take(200)
  ).map((d) => JSON.parse(d.json) as Pipeline)
}

/** The repositories a person can change: their own, and their organizations'. */
export async function reach(ctx: QueryCtx, handle: string) {
  const owners = [handle]
  const me = await accountByHandle(ctx, handle)
  if (me)
    for (const m of await ctx.db
      .query('memberships')
      .withIndex('by_personId', (q) => q.eq('personId', me._id))
      .take(500)) {
      const org = await ctx.db.get('accounts', m.organizationId)
      if (org) owners.push(org.handle)
    }
  return owners
}

export async function reposOf(ctx: QueryCtx, owner: string) {
  return await ctx.db
    .query('repos')
    .withIndex('by_owner_and_created_and_publicId', (q) => q.eq('owner', owner))
    .take(2000)
}

/**
 * The repositories a person reaches: their own, their organizations', and
 * those granted to them, each once.
 */
export async function reachable(ctx: QueryCtx, me: string) {
  const seen = new Set<Id<'repos'>>()
  const found: Array<Doc<'repos'>> = []
  const granted: Array<Doc<'repos'>> = []
  for (const g of await ctx.db
    .query('repoGrants')
    .withIndex('by_handle', (q) => q.eq('handle', me))
    .take(2000)) {
    const r = await ctx.db.get('repos', g.repoId)
    if (r) granted.push(r)
  }
  for (const r of [
    ...(
      await Promise.all((await reach(ctx, me)).map((o) => reposOf(ctx, o)))
    ).flat(),
    ...granted,
  ])
    if (!seen.has(r._id)) {
      seen.add(r._id)
      found.push(r)
    }
  return found
}

/**
 * Changes waiting on this person's review (open, by someone else, in a
 * repository they write to, with no current review of theirs), and open
 * issues given to them. The dashboard and the inbox both show these.
 */
export async function reviewsAndAssigned(ctx: QueryCtx, p: Actor) {
  const me = p.handle
  const full = (r: Doc<'repos'>) => `${r.owner}/${r.name}`
  const toReview = []
  const assigned = []
  for (const r of await reachable(ctx, me)) {
    if (await canWrite(ctx, r, p))
      for (const c of await ctx.db
        .query('changes')
        .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id))
        .take(5000)) {
        if (c.state !== 'open' || c.author.handle === me) continue
        const reviews = (
          await ctx.db
            .query('changeParts')
            .withIndex('by_changeId_and_kind_and_seq', (q) =>
              q.eq('changeId', c._id).eq('kind', 'review'),
            )
            .take(500)
        ).map(
          (x) =>
            JSON.parse(x.json) as {
              actor: { handle: string }
              carries: boolean
            },
        )
        if (!reviews.some((x) => x.actor.handle === me && x.carries))
          toReview.push({
            repo: full(r),
            number: c.number,
            title: c.title,
            author: c.author.handle,
            updated: c.updated,
          })
      }
  }
  for (const g of await ctx.db
    .query('issueAssignees')
    .withIndex('by_handle', (q) => q.eq('handle', me))
    .take(2000)) {
    const i = await ctx.db.get('issues', g.issueId)
    const r = i && (await ctx.db.get('repos', i.repoId))
    if (i && r && i.state === 'open' && (await canRead(ctx, r, p)))
      assigned.push({
        repo: full(r),
        number: i.number,
        title: i.title,
        updated: i.updated,
      })
  }
  return { toReview, assigned }
}

export const dashboardFacts = query({
  args: { account: v.optional(v.string()), at: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx, 'Sign in to see your dashboard.')
    const me = p.handle
    const account = a.account ?? p.actingAs
    if (account !== me && !(await isMember(ctx, account, me)))
      fail('not_found', `No account ${account}.`)
    const owned = await reposOf(ctx, account)
    const full = (r: Doc<'repos'>) => `${r.owner}/${r.name}`
    const ownedFacts = []
    for (const r of owned) {
      const runs = await pipelines(ctx, r)
      const changes = await ctx.db
        .query('changes')
        .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id))
        .take(5000)
      const shown = await presentRepo(ctx, r, a.at)
      let size = 0
      for (const rel of await ctx.db
        .query('releases')
        .withIndex('by_repoId_and_published', (q) => q.eq('repoId', r._id))
        .take(1000))
        size += (
          JSON.parse(rel.json) as { assets: Array<{ size: number }> }
        ).assets.reduce((n, x) => n + x.size, 0)
      ownedFacts.push({
        repo: full(r),
        id: r.publicId,
        updated: r.updated,
        upstream: !!r.upstream,
        stars: r.stars,
        starsToday: shown.stars_today,
        openChanges: shown.open_changes,
        openIssues: shown.open_issues,
        size,
        runs,
        // Open work whose newest patch set came from a tool that declared a
        // model: an agent at work, whoever's account it is.
        agentChanges: (
          await Promise.all(
            changes
              .filter((c) => c.state === 'open' || c.state === 'draft')
              .map(async (c) => {
                const parts = await ctx.db
                  .query('changeParts')
                  .withIndex('by_changeId_and_kind_and_seq', (q) =>
                    q.eq('changeId', c._id).eq('kind', 'patchSet'),
                  )
                  .take(500)
                const last = parts.at(-1)
                const via = last
                  ? ((
                      JSON.parse(last.json) as {
                        via?: {
                          machine: string | null
                          tool: string | null
                          model: string | null
                        }
                      }
                    ).via ?? null)
                  : null
                return {
                  number: c.number,
                  title: c.title,
                  state: c.state,
                  author: c.author.handle,
                  patchSets: parts.length,
                  via,
                }
              }),
          )
        ).filter((c) => !!c.via?.model),
      })
    }
    // Changes waiting on this person's review, and issues given to them.
    const { toReview, assigned } = await reviewsAndAssigned(ctx, p)
    const since = a.at - 56 * DAY
    const mine = await ctx.db
      .query('contributions')
      .withIndex('by_handle_and_at', (q) => q.eq('handle', me).gte('at', since))
      .take(10_000)
    return out({
      account,
      owned: ownedFacts,
      toReview,
      assigned,
      reviewTimes: mine.filter((c) => c.kind === 'review').map((c) => c.at),
      openedTimes: mine.filter((c) => c.kind === 'change').map((c) => c.at),
      downloads: await downloads(ctx, owned, a.at),
    })
  },
})

export const statusFacts = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await system(ctx)
    let waiting = 0
    let oldest = Infinity
    // Runs that are not finished, oldest first, across every repository.
    for (const status of ['queued', 'running'])
      for (const d of await ctx.db
        .query('pipelineRuns')
        .withIndex('by_status_and_started', (q) => q.eq('status', status))
        .take(500))
        for (const j of (JSON.parse(d.json) as Pipeline).jobs)
          if (j.status === 'queued') {
            waiting++
            oldest = Math.min(oldest, d.started)
          }
    return out({
      waiting,
      oldest: waiting ? oldest : null,
      counts: await countsOf(ctx),
    })
  },
})
