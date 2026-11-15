import { uploadMoveRefusal } from '@source-code/api/lifecycles'
import { fail } from './errors'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * Attaches an upload to what a write adds (evidence, a release's file), in
 * that write's own transaction: of two writes that use one upload at once,
 * exactly one gets it. An upload is attached once, and only once its file
 * has arrived (`uploadLifecycle`).
 */
export async function attachUpload(
  ctx: MutationCtx,
  uploadId: string,
  repo: Doc<'repos'>,
) {
  const u = await ctx.db
    .query('uploads')
    .withIndex('by_publicId', (q) => q.eq('publicId', uploadId))
    .unique()
  if (!u) fail('not_found', `No upload ${uploadId}.`)
  const attachedTo = `${repo.owner}/${repo.name}`
  const refusal =
    u.attachedTo !== null
      ? `${uploadId} is already attached.`
      : uploadMoveRefusal(u, { ...u, attachedTo })
  if (refusal) fail('invalid_state', refusal)
  await ctx.db.patch('uploads', u._id, {
    attachedTo,
    attachedRepoId: repo.publicId,
  })
}
