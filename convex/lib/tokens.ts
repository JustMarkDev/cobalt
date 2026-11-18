import { newId } from '@source-code/api/ids'
import { hashToken, secretFor } from '@source-code/api/auth'
import { repoByKey, repoByPublicId } from './access'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/** Tokens: made here with their secret handed back once; only the hash is kept. */

/** `rep_...` ids, or `n:owner/name` for a name that had no repository. */
async function toRefs(ctx: QueryCtx, names: Array<string>) {
  const refs: Array<string> = []
  for (const n of names) {
    const r = await repoByKey(ctx, n)
    refs.push(r ? r.publicId : `n:${n.toLowerCase()}`)
  }
  return refs
}

/** The current lowercase names; repositories that are gone drop out. */
async function toNames(ctx: QueryCtx, refs: Array<string>, since: number) {
  const names: Array<string> = []
  for (const ref of refs) {
    if (ref.startsWith('n:')) {
      const name = ref.slice(2)
      // A repository made at that name later is not the one this token was given.
      if (!(await repoByKey(ctx, name))) names.push(name)
      continue
    }
    const r = await repoByPublicId(ctx, ref)
    // A repository that changed hands after the token was made is not one
    // its new owner gave it.
    if (r && !((r.ownerSince ?? -1) >= since))
      names.push(`${r.owner}/${r.name}`.toLowerCase())
  }
  return names
}

export async function record(ctx: QueryCtx, t: Doc<'tokens'>) {
  return {
    id: t.publicId,
    name: t.name,
    kind: t.kind === 'oauth' ? ('oauth' as const) : ('personal' as const),
    handle: t.handle,
    actingAs: t.actingAs,
    device: t.device ?? null,
    scopes: t.scopes,
    repos: t.repos ? await toNames(ctx, t.repos, t.createdAt) : null,
    audience: t.audience,
    prefix: t.prefix,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    ...(t.authorizationId ? { authorizationId: t.authorizationId } : {}),
    ...(t.limitKey ? { limitKey: t.limitKey } : {}),
    ...(t.loginId ? { loginId: t.loginId } : {}),
  }
}

export async function mintToken(
  ctx: MutationCtx,
  args: {
    id?: string
    name: string
    kind: 'personal' | 'oauth'
    handle: string
    actingAs?: string
    device?: string | null
    scopes: Array<string>
    repos?: Array<string> | null
    audience?: Array<'api' | 'mcp'>
    ttlMs: number
    authorizationId?: string
    limitKey?: string
    loginId?: string
    secret?: string
  },
) {
  const secret = args.secret ?? secretFor(args.kind)
  const at = Date.now()
  const id = await ctx.db.insert('tokens', {
    publicId: args.id ?? newId('token', at),
    hash: hashToken(secret),
    name: args.name,
    kind: args.kind,
    handle: args.handle,
    actingAs: args.actingAs ?? args.handle,
    device: args.device ?? null,
    scopes: [...args.scopes],
    repos: args.repos ? await toRefs(ctx, args.repos) : null,
    audience: args.audience ?? ['api', 'mcp'],
    prefix: secret.slice(0, 8),
    createdAt: at,
    expiresAt: at + args.ttlMs,
    lastUsedAt: null,
    revokedAt: null,
    ...(args.authorizationId ? { authorizationId: args.authorizationId } : {}),
    ...(args.limitKey ? { limitKey: args.limitKey } : {}),
    ...(args.loginId ? { loginId: args.loginId } : {}),
  })
  return {
    record: await record(ctx, (await ctx.db.get('tokens', id))!),
    secret,
  }
}

export async function revokeToken(ctx: MutationCtx, id: string) {
  const t = await ctx.db
    .query('tokens')
    .withIndex('by_publicId', (q) => q.eq('publicId', id))
    .unique()
  if (!t || t.revokedAt !== null) return false
  await ctx.db.patch('tokens', t._id, { revokedAt: Date.now() })
  return true
}

export type { Doc }
