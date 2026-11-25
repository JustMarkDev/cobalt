import { principalOf } from './auth'
import { ApiError } from './problem'
import type { GitRemotes } from '@cobaltforge/git/remote'
import type { Principal } from './auth'
import type { DomainPort } from './domain/port'

type Access = 'read' | 'write'

/** The four requests git makes over HTTPS, and what each needs. */
const routes = new Map<string, Access>([
  ['GET info/refs?service=git-upload-pack', 'read'],
  ['POST git-upload-pack', 'read'],
  ['GET info/refs?service=git-receive-pack', 'write'],
  ['POST git-receive-pack', 'write'],
])

const requestHeaders = [
  'accept',
  'content-type',
  'content-encoding',
  'git-protocol',
  'user-agent',
]
const responseHeaders = ['content-type', 'cache-control']

export type GitHttpOptions = {
  verifyToken: (
    token: string,
    audience: 'api',
  ) => Promise<
    | { ok: true; record: Parameters<typeof principalOf>[0] }
    | { ok: false; reason: string }
  >
  domain: Pick<DomainPort, 'gitAccess'>
  remotes: GitRemotes
  /**
   * Before a fetch or push of a linked repository starts: refresh its provider
   * credential, pull when the last pull is old, refuse a push whose link is
   * broken. Throws an ApiError to refuse.
   */
  beforeGit?: (full: string, write: boolean) => Promise<void>
  fetch?: typeof fetch
  /** One line per request: who, which repository, what, and the answer. */
  log?: (line: Record<string, unknown>) => void
}

const notFound = () =>
  new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  })

const challenge = () =>
  new Response('Sign in with your cobalt token as the password.\n', {
    status: 401,
    headers: {
      'content-type': 'text/plain',
      'www-authenticate': 'Basic realm="cobalt"',
    },
  })

/** `git` sends the token as the Basic password; a Bearer header works too. */
function tokenOf(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const [scheme = '', value = ''] = header.split(' ')
  if (scheme.toLowerCase() === 'bearer') return value || null
  if (scheme.toLowerCase() !== 'basic') return null
  try {
    const text = atob(value)
    const at = text.indexOf(':')
    const pass = at < 0 ? '' : text.slice(at + 1)
    return pass || null
  } catch {
    return null
  }
}

function matchRoute(url: URL) {
  const m = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/.exec(url.pathname)
  if (!m) return null
  const [, owner = '', name = '', endpoint = ''] = m
  const path = endpoint + url.search
  return { owner, name, path, access: routes.get(path) }
}

/**
 * Git over HTTPS on this domain: sign in with a cobalt token, then the
 * request goes on to Code Storage with a token of its own for that one
 * repository. A person never holds a Code Storage credential.
 */
export function createGitHttp(o: GitHttpOptions) {
  const send = o.fetch ?? fetch
  const log = o.log ?? (() => undefined)

  return async function gitHttp(req: Request, ip = 'unknown') {
    const url = new URL(req.url)
    const route = matchRoute(url)
    if (!route) return notFound()
    const need = routes.get(`${req.method} ${route.path}`)
    if (!need) return notFound()

    const token = tokenOf(req)
    if (!token) return challenge()
    const found = await o.verifyToken(token, 'api')
    if (!found.ok) return challenge()
    const principal: Principal = principalOf(found.record)
    const scope = need === 'write' ? 'repo:write' : 'repo:read'
    // A token limited to some paths cannot hand out whole-repository access.
    if (!principal.scopes.has(scope) || principal.paths) return notFound()

    let access: { storeId: string; defaultBranch: string }
    try {
      access = await o.domain.gitAccess(
        route.owner,
        route.name,
        principal,
        need,
      )
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null
      // A repository someone cannot see does not exist for them.
      if (code === 'not_found' || code === 'moved') return notFound()
      if (code === 'forbidden')
        return new Response('You can read this repository but not push.\n', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        })
      throw e
    }

    if (o.beforeGit && route.path.startsWith('info/refs'))
      try {
        await o.beforeGit(`${route.owner}/${route.name}`, need === 'write')
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        // git prints a plain-text body of a refused request.
        const hint = e.hint ? `\n${e.hint}` : ''
        return new Response(`${e.detail}${hint}\n`, {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        })
      }

    const remote = await o.remotes.open(access.storeId, {
      write: need === 'write',
      subject: principal.handle,
      protect: need === 'write' ? access.defaultBranch : undefined,
    })
    const headers = new Headers({ authorization: remote.authorization })
    for (const name of requestHeaders) {
      const value = req.headers.get(name)
      if (value) headers.set(name, value)
    }
    const res = await send(`${remote.url}/${route.path}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : req.body,
      ...(req.method === 'GET' ? {} : { duplex: 'half' }),
    })
    const out = new Headers()
    for (const name of responseHeaders) {
      const value = res.headers.get(name)
      if (value) out.set(name, value)
    }
    log({
      user: principal.handle,
      ip,
      repo: `${route.owner}/${route.name}`,
      path: route.path,
      status: res.status,
    })
    return new Response(res.body, { status: res.status, headers: out })
  }
}
