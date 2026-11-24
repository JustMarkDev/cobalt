import { uploadMoveRefusal } from '@cobaltforge/api/lifecycles'
import { fail } from './errors'
import type { Actor } from './actor'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

export async function attachUpload(
  ctx: MutationCtx,
  uploadId: string,
  repo: Doc<'repos'>,
  by: Actor,
  fits?: (contentType: string) => boolean,
) {
  const u = await ctx.db
    .query('uploads')
    .withIndex('by_publicId', (q) => q.eq('publicId', uploadId))
    .unique()
  if (!u || (!by.system && u.owner !== by.handle))
    fail('not_found', `No upload ${uploadId}.`)
  if (fits && !fits(u.contentType))
    fail('invalid_request', `A ${u.contentType} file does not fit here.`)
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
  return u
}

export const evidenceFits: Record<string, (type: string) => boolean> = {
  image: (t) => t.startsWith('image/'),
  recording: (t) => t.startsWith('video/'),
  preview: (t) => t === 'text/html',
  test_results: (t) => t === 'application/json' || t === 'text/plain',
}

export const evidenceUpload = (u: Doc<'uploads'>) => ({
  id: u.publicId,
  contentType: u.contentType,
  size: u.size,
  sha256: u.sha256 ?? '',
})
