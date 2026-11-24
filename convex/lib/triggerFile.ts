import { isTriggerFile, parseTriggerFiles } from '@cobaltforge/api/trigger-file'
import { counters, emit } from './events'
import type { ActorRef } from './events'
import type { ChangeRec } from './changeTypes'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/** A repository's trigger files and the set in force, as stored. */
export async function loadTriggers(ctx: QueryCtx, repo: Doc<'repos'>) {
  return await ctx.db
    .query('repoTriggers')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
}

/**
 * A change that edits trigger files landed: every trigger file is read
 * together. When they read, their triggers are in force; when they do not,
 * the last valid set stays and the errors are shown. A broken trigger file
 * never blocks the change. Runs right after `readLandedPolicy`, from the
 * landed patch set's contents (on code.storage, from the push that lands it).
 */
export async function readLandedTriggers(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  c: ChangeRec,
  by: ActorRef,
) {
  const head = c.patchSets[c.patchSets.length - 1]
  const touched = Object.entries(head.contents ?? {}).filter(([path]) =>
    isTriggerFile(path),
  )
  if (!touched.length) return
  const had = await loadTriggers(ctx, repo)
  const files = had
    ? (JSON.parse(had.sourceText) as Record<string, string>)
    : {}
  for (const [path, text] of touched)
    if (typeof text === 'string') files[path] = text
    else delete files[path]
  const { triggers, errors } = parseTriggerFiles(files)
  const fields = {
    sourceText: JSON.stringify(files),
    sourceSha: head.sha,
    triggersJson: triggers
      ? JSON.stringify(triggers)
      : (had?.triggersJson ?? '[]'),
    errors: JSON.stringify(errors),
    rev: (had?.rev ?? 0) + 1,
  }
  if (had) await ctx.db.patch('repoTriggers', had._id, fields)
  else await ctx.db.insert('repoTriggers', { repoId: repo._id, ...fields })
  const n = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', n._id, {
    triggersRev: (n.triggersRev ?? 0) + 1,
  })
  await emit(
    ctx,
    repo,
    'repo.triggers_changed',
    by,
    { object: 'repo', id: repo.publicId, number: null },
    [errors.length ? 'source.errors' : 'source'],
    null,
  )
}
