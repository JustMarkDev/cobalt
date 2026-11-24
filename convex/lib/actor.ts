import { fail } from './errors'
import { env } from '../_generated/server'
import type { QueryCtx } from '../_generated/server'

export type Via = {
  machine: string | null
  tool: string | null
  model: string | null
}

export type Actor = {
  handle: string
  actingAs: string
  via: Via
  session: boolean
  scopes: ReadonlySet<string>
  repos: ReadonlyArray<string> | null
  paths?: ReadonlyArray<string> | null
  runnerId?: string | null
  tokenId: string | null
  loginId?: string | null
  system: boolean
}

export const allScopes = [
  'repo:read',
  'repo:write',
  'issues:read',
  'issues:comment',
  'issues:write',
  'pulls:read',
  'pulls:comment',
  'pulls:write',
  'pulls:merge',
  'secrets:schema',
  'secrets:write',
  'secrets:decrypt',
  'webhooks:read',
  'webhooks:write',
  'tokens:manage',
  'runners:manage',
] as const

export const claim = {
  api: 'cb_api',
  token: 'cb_tok',
  login: 'cb_login',
  device: 'cb_dev',
  tool: 'cb_tool',
  model: 'cb_model',
  session: 'cb_ses',
  actingAs: 'cb_act',
  scopes: 'cb_scp',
  repos: 'cb_rep',
  paths: 'cb_pth',
  runner: 'cb_run',
  system: 'cb_sys',
  idempotency: 'cb_idem',
} as const

type Ctx = Pick<QueryCtx, 'auth' | 'db'>

export async function actorOf(ctx: Ctx): Promise<Actor | null> {
  const id = await ctx.auth.getUserIdentity()
  if (!id) return null
  if (fromApi(id)) {
    const scopes = id[claim.scopes]
    const repos = id[claim.repos]
    const acting = id[claim.actingAs]
    const token = id[claim.token]
    const text = (k: string) => {
      const v = id[k]
      return typeof v === 'string' && v ? v : null
    }
    return {
      handle: id.subject,
      actingAs: typeof acting === 'string' ? acting : id.subject,
      via: {
        machine: text(claim.device),
        tool: text(claim.tool),
        model: text(claim.model),
      },
      session: id[claim.session] === 'true',
      scopes: new Set(
        typeof scopes === 'string' ? scopes.split(' ').filter(Boolean) : [],
      ),
      repos:
        typeof repos === 'string'
          ? repos
              .split(',')
              .filter(Boolean)
              .map((r) => r.toLowerCase())
          : null,
      tokenId: typeof token === 'string' ? token : null,
      loginId: text(claim.login),
      paths: pathsOf(text(claim.paths)),
      runnerId: text(claim.runner),
      system: id[claim.system] === true || id[claim.system] === 'true',
    }
  }
  const account = await ctx.db
    .query('accounts')
    .withIndex('by_authId', (q) => q.eq('authId', id.subject))
    .unique()
  if (!account || account.kind !== 'person') return null
  return {
    handle: account.handle,
    actingAs: account.handle,
    via: { machine: 'browser', tool: 'cobalt', model: null },
    session: true,
    scopes: new Set(allScopes),
    repos: null,
    tokenId: null,
    system: false,
  }
}

function pathsOf(json: string | null): Array<string> | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}

export function fromApi(id: Record<string, unknown> & { issuer?: string }) {
  if (id[claim.api] !== 'true') return false
  const issuer = env.API_JWT_ISSUER
  return !!issuer && id.issuer === issuer
}

export async function signedIn(
  ctx: Ctx,
  why = 'Sign in first.',
): Promise<Actor> {
  const a = await actorOf(ctx)
  if (!a) fail('unauthenticated', why)
  return a
}

export async function system(ctx: Ctx): Promise<Actor> {
  const a = await actorOf(ctx)
  if (!a?.system) fail('forbidden', 'Only the API server can do this.')
  return a
}
