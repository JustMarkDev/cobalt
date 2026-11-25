import type { MutationCtx } from '../_generated/server'

export async function queueSweep(
  ctx: MutationCtx,
  kind: 'git' | 'blob' | 'provider',
  key: string,
) {
  await ctx.db.insert('sweeps', { kind, key, created: Date.now(), lease: 0 })
}
