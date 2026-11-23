import { v } from 'convex/values'
import { ConvexError } from 'convex/values'
import { MAX_RUNS_PER_EVENT, triggersFor } from '@source-code/api/trigger-file'
import type { FileError, Trigger } from '@source-code/api/trigger-file'
import { touchedFiles } from '@source-code/api/paths'
import { presentTriggers } from '@source-code/api/triggers'
import { query } from '../_generated/server'
import { actorOf } from '../lib/actor'
import { accessStamp, resolve } from '../lib/access'
import { out } from '../lib/errors'
import { counters } from '../lib/events'
import { urls } from '../lib/present'
import { loadTriggers } from '../lib/triggerFile'
import { notify } from './notifications'
import { startPipelineForEvent } from './pipelines'
import type { ChangeRec } from '../lib/changeTypes'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * Triggers: `.source/triggers/*.yml` says what starts a workflow when
 * something happens. The only event that dispatches in this version is
 * `change.landed`, from the land path, in the same transaction.
 */

async function ran(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  triggerId: string,
  eventSequence: number,
) {
  return await ctx.db
    .query('triggerRuns')
    .withIndex('by_repoId_and_triggerId_and_eventSequence', (q) =>
      q
        .eq('repoId', repo._id)
        .eq('triggerId', triggerId)
        .eq('eventSequence', eventSequence),
    )
    .unique()
}

/**
 * Starts what an event triggers: each matching trigger once per event (what
 * it did is recorded first, so a retry finds it), at most three. A workflow
 * that never ran is recorded and the change's author told; the land itself
 * never fails here.
 */
export async function dispatchTriggers(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  c: ChangeRec,
  e: { type: string; actor: string; model: string | null; sequence: number },
) {
  const doc = await loadTriggers(ctx, repo)
  if (!doc) return
  const set = JSON.parse(doc.triggersJson) as Array<Trigger>
  if (!set.length) return
  const head = c.patchSets[c.patchSets.length - 1]
  const { start, capped } = triggersFor(set, {
    type: e.type,
    actor: e.actor,
    model: e.model,
    files: [...touchedFiles(head)],
    labels: c.labels,
  })
  const at = Date.now()
  for (const t of capped)
    if (!(await ran(ctx, repo, t.id, e.sequence)))
      await ctx.db.insert('triggerRuns', {
        repoId: repo._id,
        triggerId: t.id,
        eventSequence: e.sequence,
        runId: null,
        run: null,
        state: 'capped',
        error: `More than ${MAX_RUNS_PER_EVENT} triggers matched; this one did not start.`,
        at,
      })
  for (const t of start) {
    if (await ran(ctx, repo, t.id, e.sequence)) continue
    const id = await ctx.db.insert('triggerRuns', {
      repoId: repo._id,
      triggerId: t.id,
      eventSequence: e.sequence,
      runId: null,
      run: null,
      state: 'started',
      error: null,
      at,
    })
    try {
      const r = await startPipelineForEvent(ctx, repo, {
        workflow: t.run,
        branch: c.base,
        sha: head.sha,
        actor: e.actor,
      })
      await ctx.db.patch('triggerRuns', id, { runId: r.id, run: r.number })
    } catch (err) {
      // `startWorkflow` refuses before it writes anything, so nothing is left half done.
      const why =
        err instanceof ConvexError
          ? String((err.data as { detail?: string }).detail ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err)
      await ctx.db.patch('triggerRuns', id, { state: 'failed', error: why })
      const full = `${repo.owner}/${repo.name}`
      await notify(ctx, c.author.handle, {
        kind: 'ci',
        title: `Trigger ${t.id} did not start ${t.run}: ${why}`,
        repo: full,
        path: `/${full}/settings?section=automations`,
      })
    }
  }
  const n = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', n._id, {
    triggersRev: (n.triggersRev ?? 0) + 1,
  })
}

export const get = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const doc = await loadTriggers(ctx, repo)
    const runs = await ctx.db
      .query('triggerRuns')
      .withIndex('by_repoId_and_at', (q) => q.eq('repoId', repo._id))
      .order('desc')
      .take(20)
    return out(
      presentTriggers(
        `${repo.owner}/${repo.name}`,
        urls().html,
        repo.defaultBranch,
        doc
          ? {
              files: JSON.parse(doc.sourceText) as Record<string, string>,
              sha: doc.sourceSha,
              set: JSON.parse(doc.triggersJson) as Array<Trigger>,
              errors: JSON.parse(doc.errors) as Array<FileError>,
            }
          : null,
        runs,
      ),
    )
  },
})

export const version = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const repo = await resolve(ctx, a.owner, a.name, await actorOf(ctx))
    const c = await counters(ctx, repo)
    return out(
      `${repo.publicId}.t${c.triggersRev ?? 0}.${await accessStamp(ctx, repo)}`,
    )
  },
})
