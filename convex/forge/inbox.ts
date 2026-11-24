import { v } from 'convex/values'
import { queuedWithoutRunner, stepsWaitingOn } from '@cobaltforge/api/inbox'
import { query } from '../_generated/server'
import { signedIn } from '../lib/actor'
import { canRead } from '../lib/access'
import { hydrate, viewFor } from '../lib/changes'
import { out } from '../lib/errors'
import { pipelines, reach, reachable, reviewsAndAssigned } from './insights'
import { load, runnersOf } from './pipelines'
import type { Doc } from '../_generated/dataModel'

const MAX_REPOS = 200

export const facts = query({
  args: { at: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx, 'Sign in to see your inbox.')
    const me = p.handle
    const full = (r: Doc<'repos'>) => `${r.owner}/${r.name}`
    const { toReview, assigned } = await reviewsAndAssigned(ctx, p)
    const owners = new Set(await reach(ctx, me))
    const repos = (await reachable(ctx, me)).slice(0, MAX_REPOS)
    const readable: Array<Doc<'repos'>> = []
    for (const r of repos) if (await canRead(ctx, r, p)) readable.push(r)

    const mainFailures = []
    const blocked = []
    const checksFailing = []
    const waiting = []
    const noRunner = []
    const runnersByOwner = new Map<
      string,
      Awaited<ReturnType<typeof runnersOf>>
    >()
    for (const r of readable) {
      if (owners.has(r.owner)) {
        const main = (await pipelines(ctx, r)).find(
          (x) =>
            x.branch === 'main' &&
            x.status !== 'queued' &&
            x.status !== 'running' &&
            x.status !== 'waiting',
        )
        if (main?.status === 'failure')
          mainFailures.push({
            repo: full(r),
            number: main.number,
            workflow: main.workflow,
            title: main.title,
            started: main.started,
          })
      }
      const mine = (
        await ctx.db
          .query('changes')
          .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id))
          .take(5000)
      ).filter((c) => c.state === 'open' && c.author.handle === me)
      if (mine.length) {
        const view = await viewFor(ctx, r, p, a.at, mine)
        for (const doc of mine) {
          const { rec } = await hydrate(ctx, doc)
          const reqs = view.evaluate(rec)
          if (view.policyState(reqs) === 'blocked')
            blocked.push({
              repo: full(r),
              number: rec.number,
              title: rec.title,
              updated: rec.updated,
              blocking: view.unmet(reqs),
            })
          const checks = view.checksFor(rec)
          if (checks.state === 'fail')
            checksFailing.push({
              repo: full(r),
              number: rec.number,
              title: rec.title,
              updated: rec.updated,
              failed: checks.failed,
            })
        }
      }
      for (const status of ['waiting', 'running', 'queued'])
        for (const d of await ctx.db
          .query('pipelineRuns')
          .withIndex('by_repoId_and_status_and_started', (q) =>
            q.eq('repoId', r._id).eq('status', status),
          )
          .take(200)) {
          const run = await load(ctx, d)
          waiting.push(...stepsWaitingOn(full(r), run, me))
          if (status === 'waiting' || run.actor !== me) continue
          let runners = runnersByOwner.get(r.owner)
          if (!runners) {
            runners = await runnersOf(ctx, r.owner)
            runnersByOwner.set(r.owner, runners)
          }
          const stuck = queuedWithoutRunner(r, run, runners)
          if (stuck) noRunner.push(stuck)
        }
    }

    const mentions = []
    for (const n of await ctx.db
      .query('notifications')
      .withIndex('by_handle_and_unread', (q) =>
        q.eq('handle', me).eq('unread', true),
      )
      .take(500)) {
      if (n.kind !== 'mention') continue
      let repo: Doc<'repos'> | null = null
      if (n.repoId)
        repo = await ctx.db
          .query('repos')
          .withIndex('by_publicId', (q) => q.eq('publicId', n.repoId!))
          .unique()
      if (n.repoId && (!repo || !(await canRead(ctx, repo, p)))) continue
      mentions.push({
        id: n.publicId,
        title: n.title,
        repo: repo ? full(repo) : n.repo,
        path: repo ? `/${full(repo)}${n.path}` : n.path,
        created: n.created,
      })
    }

    return out({
      owned: readable.filter((r) => owners.has(r.owner)).map(full),
      mainFailures,
      toReview,
      assigned,
      blocked,
      checksFailing,
      waiting,
      noRunner,
      mentions,
    })
  },
})
