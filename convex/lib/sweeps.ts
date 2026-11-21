import type { MutationCtx } from '../_generated/server'

/**
 * Work outside Convex that follows an erasure: a git store to delete from
 * code.storage, an uploaded file to delete from the bucket. Convex cannot reach
 * either, so it leaves a note here and the store worker on the API server
 * (`storeWorker.ts`) does it and takes the note away. The note holds an opaque
 * store or upload id and nothing that names a person.
 */
export async function queueSweep(
  ctx: MutationCtx,
  kind: 'git' | 'blob',
  key: string,
) {
  await ctx.db.insert('sweeps', { kind, key, created: Date.now(), lease: 0 })
}
