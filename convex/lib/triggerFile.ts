import { isTriggerFile, parseTriggerFiles } from '@cobaltforge/api/trigger-file'
import { counters, emit } from './events'
import type { ActorRef } from './events'
import type { ChangeRec } from './changeTypes'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export async function loadTriggers(ctx: QueryCtx, repo: Doc<'repos'>) {
  return await ctx.db
    .query('repoTriggers')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
}

export async function readLandedTriggers(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  c: ChangeRec,
  by: ActorRef,
) {
  const head = c.patchSets[c.patchSets.length - 1]
  await readTriggerSource(ctx, repo, head, by)
}

/**
 * Trigger files as a commit has them. With `complete`, `contents` holds every
 * trigger file there is (the default branch, read from git), so the others go.
 */
export async function readTriggerSource(
  ctx: MutationCtx,
  repo: Doc<'repos'>,
  head: { sha: string; contents?: Record<string, string | null> },
  by: ActorRef,
  complete = false,
) {
  const touched = Object.entries(head.contents ?? {}).filter(([path]) =>
    isTriggerFile(path),
  )
  const had = await loadTriggers(ctx, repo)
  if (!touched.length && !(complete && had)) return
  const before = had
    ? (JSON.parse(had.sourceText) as Record<string, string>)
    : {}
  const files: Record<string, string> = complete ? {} : { ...before }
  for (const [path, text] of touched)
    if (typeof text === 'string') files[path] = text
    else delete files[path]
  if (had && JSON.stringify(files) === JSON.stringify(before)) return
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
