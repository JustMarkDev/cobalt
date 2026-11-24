import { fail } from './errors'
import { env } from '../_generated/server'
import type { QueryCtx } from '../_generated/server'

/**
 * Who is calling, from the token Convex verified, never from an argument.
 *
 * Two issuers sign tokens Convex accepts (`auth.config.ts`):
 *  - sign-in (Better Auth), for a person in the browser. They act as
 *    themself with every scope, as they would with a full personal token.
 *  - the HTTP API, after it checked a bearer token. Its short JWT carries
 *    the principal the API worked out: the login, the account it acts as,
 *    the scopes, the repositories it is limited to, and the receipt (the
 *    machine, tool and declared model) every write records.
 *
 * The same `Actor` comes out of both, so a rule is written once. There is no
 * kind of actor: an account is responsible for what it writes, whatever typed
 * it.
 */
export type Via = {
  machine: string | null
  tool: string | null
  model: string | null
}

export type Actor = {
  /** The login. */
  handle: string
  /** The account the request acts as. */
  actingAs: string
  /** How this request got here; the receipt its writes keep. */
  via: Via
  /** A signed-in page, not a token: the only place production access is confirmed. */
  session: boolean
  scopes: ReadonlySet<string>
  /** Lowercase `owner/name` list when limited to repositories. */
  repos: ReadonlyArray<string> | null
  /** Globs a change may touch, when the token is limited to paths. */
  paths?: ReadonlyArray<string> | null
  /** The runner, when the caller is one by its token. */
  runnerId?: string | null
  /** The API token behind the request; null for a browser session. */
  tokenId: string | null
  /**
   * The login behind it: the OAuth authorization, or the token itself. What
   * a production confirmation is bound to, the same as the API's principal.
   */
  loginId?: string | null
  /** The API server itself, for housekeeping no person asked for. */
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

/** The claims the API puts in its JWT. Short names: they ride on every call. */
export const claim = {
  /** Present only on the API's own JWT. */
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
  /** Paths a token may change, as JSON. */
  paths: 'cb_pth',
  /** The runner a token belongs to. */
  runner: 'cb_run',
  system: 'cb_sys',
  /** `[scope, key]` of the request's Idempotency-Key, as JSON. */
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
  // A browser session: the person whose sign-in this is.
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

/**
 * Whether a verified identity is the API's own JWT. It must carry the API's
 * marker claim and come from the API's issuer: a sign-in token can never
 * pass for the API, so it can never set its own scopes, receipt or session
 * flag. A deployment that does not know the issuer trusts no API token
 * (`auth.config.ts` does not accept one then either).
 */
export function fromApi(id: Record<string, unknown> & { issuer?: string }) {
  if (id[claim.api] !== 'true') return false
  const issuer = env.API_JWT_ISSUER
  return !!issuer && id.issuer === issuer
}

/** The caller, who must be signed in. */
export async function signedIn(
  ctx: Ctx,
  why = 'Sign in first.',
): Promise<Actor> {
  const a = await actorOf(ctx)
  if (!a) fail('unauthenticated', why)
  return a
}

/** Only the API server, for housekeeping. */
export async function system(ctx: Ctx): Promise<Actor> {
  const a = await actorOf(ctx)
  if (!a?.system) fail('forbidden', 'Only the API server can do this.')
  return a
}
