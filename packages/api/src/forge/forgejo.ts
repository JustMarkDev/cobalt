import { call, toMs } from './http'
import { hmacHex, sameText } from './vault'
import { ProviderError } from './types'
import type {
  ExternalActor,
  Fetch,
  ForgeProvider,
  OAuthTokens,
  ProviderAuth,
  ProviderId,
  ProviderOAuth,
  RemoteComment,
  RemoteIssue,
  RemotePull,
  RemoteRelease,
  RemoteRepo,
  WebhookEvent,
} from './types'

export type ForgejoConfig = {
  id: ProviderId
  host: string
  clientId: string
  clientSecret: string
  base?: string
  fetch?: Fetch
  now?: () => number
}

type FjUser = {
  id: number
  login: string
  full_name?: string
  avatar_url?: string
}

type FjRepo = {
  id: number
  full_name: string
  private: boolean
  archived?: boolean
  fork?: boolean
  default_branch?: string
  size?: number
  description?: string
  stars_count?: number
  forks_count?: number
  website?: string
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean }
}

const actor = (u: FjUser | null | undefined): ExternalActor | null =>
  u
    ? {
        id: String(u.id),
        login: u.login,
        name: u.full_name || null,
        avatar: u.avatar_url ?? null,
      }
    : null

export function repoOfForgejo(
  r: FjRepo,
  provider: ProviderId,
  host: string,
): RemoteRepo {
  return {
    provider,
    instance: host,
    id: String(r.id),
    slug: r.full_name,
    private: r.private,
    archived: r.archived ?? false,
    fork: r.fork ?? false,
    defaultBranch: r.default_branch || 'main',
    sizeBytes: (r.size ?? 0) * 1024,
    description: r.description ?? '',
    stars: r.stars_count ?? 0,
    forks: r.forks_count ?? 0,
    license: null,
    website: r.website || null,
    canPush: r.permissions
      ? Boolean(r.permissions.push || r.permissions.admin)
      : null,
    canAdmin: r.permissions ? Boolean(r.permissions.admin) : null,
  }
}

export function createForgejo(cfg: ForgejoConfig): {
  forge: ForgeProvider
  oauth: ProviderOAuth
} {
  const web = cfg.base ?? `https://${cfg.host}`
  const api = `${web}/api/v1`
  const f: Fetch = cfg.fetch ?? ((u, i) => fetch(u, i))
  const now = cfg.now ?? Date.now
  const id = cfg.id

  const headers = (auth: ProviderAuth) => {
    if (auth.kind !== 'user')
      throw new ProviderError(
        id,
        400,
        `${cfg.host} is reached with a person token.`,
        false,
      )
    return { authorization: `token ${auth.token}`, 'user-agent': 'cobaltforge' }
  }
  const get = <T>(auth: ProviderAuth, path: string, etag?: string | null) =>
    call<T>(id, f, path.startsWith('http') ? path : `${api}${path}`, {
      headers: headers(auth),
      etag,
    })

  async function token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await f(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...body,
      }).toString(),
    })
    const j = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }
    if (!res.ok || !j.access_token)
      throw new ProviderError(
        id,
        res.status,
        `${cfg.host} refused the token request: ${j.error ?? res.status}${j.error_description ? ` (${j.error_description})` : ''}`,
        res.status === 400 || res.status === 401,
      )
    return {
      access: j.access_token,
      refresh: j.refresh_token ?? null,
      expiresAt: j.expires_in ? now() + j.expires_in * 1000 : null,
      scopes: (j.scope ?? '').split(/[ ,]+/).filter(Boolean),
    }
  }

  const oauth: ProviderOAuth = {
    id,
    scopes: [],
    authorizeUrl: (state, redirectUri) =>
      `${web}/login/oauth/authorize?${new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
      })}`,
    exchange: (code, redirectUri) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    revoke: () => Promise.resolve(),
    async whoami(t) {
      const r = await get<FjUser>({ kind: 'user', token: t }, '/user')
      return { id: String(r.body.id), login: r.body.login }
    },
  }

  const forge: ForgeProvider = {
    id,
    host: cfg.host,
    capabilities: {
      mode: 'generic',
      lfs: false,
      webhooks: 'repo',
      signature: 'hmac-sha256',
      refreshRotates: true,
    },

    async listRepos(auth, o) {
      const per = Math.min(o.perPage ?? 50, 50)
      const r = await get<Array<FjRepo>>(
        auth,
        o.cursor ?? `/user/repos?limit=${per}&page=1`,
      )
      return {
        items: r.body.map((x) => repoOfForgejo(x, id, cfg.host)),
        next: r.next,
      }
    },

    async getRepo(auth, slug) {
      const r = await get<FjRepo>(auth, `/repos/${slug}`)
      return repoOfForgejo(r.body, id, cfg.host)
    },

    async languages(auth, slug) {
      const r = await get<Record<string, number>>(
        auth,
        `/repos/${slug}/languages`,
      )
      return Object.entries(r.body).sort((a, b) => b[1] - a[1])
    },

    async readFile(auth, slug, path) {
      const res = await f(`${api}/repos/${slug}/raw/${path}`, {
        headers: headers(auth),
      })
      if (res.status === 404) return null
      if (!res.ok)
        throw new ProviderError(
          id,
          res.status,
          `${cfg.host} answered ${res.status}`,
        )
      return res.text()
    },

    gitCredential: (auth, login) =>
      auth.kind === 'user' ? { username: login, password: auth.token } : null,

    async createWebhook(auth, slug, hook) {
      const r = await call<{ id: number }>(
        id,
        f,
        `${api}/repos/${slug}/hooks`,
        {
          method: 'POST',
          headers: headers(auth),
          body: {
            type: 'forgejo',
            active: true,
            events: [
              'push',
              'create',
              'delete',
              'repository',
              'pull_request',
              'issues',
              'issue_comment',
              'release',
            ],
            config: {
              url: hook.url,
              content_type: 'json',
              secret: hook.secret,
            },
          },
        },
      )
      return { id: String(r.body.id) }
    },

    async deleteWebhook(auth, slug, hookId) {
      try {
        await call(id, f, `${api}/repos/${slug}/hooks/${hookId}`, {
          method: 'DELETE',
          headers: headers(auth),
        })
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) throw e
      }
    },

    async verifyWebhook(h, body, secret) {
      const sig =
        h.get('x-forgejo-signature') ?? h.get('x-gitea-signature') ?? ''
      return sig.length > 0 && sameText(sig, await hmacHex(secret, body))
    },

    parseWebhook(h, body) {
      return {
        id: h.get('x-forgejo-delivery') ?? h.get('x-gitea-delivery') ?? '',
        event: forgejoEvent(
          h.get('x-forgejo-event') ?? h.get('x-gitea-event') ?? '',
          body,
        ),
      }
    },

    async listPulls(auth, slug, o) {
      const r = await get<Array<FjPull>>(
        auth,
        o.cursor ?? `/repos/${slug}/pulls?state=all&limit=50&sort=recentupdate`,
        o.cursor ? null : o.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(pullOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listIssues(auth, slug, o) {
      const r = await get<Array<FjIssue>>(
        auth,
        o.cursor ?? `/repos/${slug}/issues?state=all&type=issues&limit=50`,
        o.cursor ? null : o.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(issueOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listReleases(auth, slug, o) {
      const r = await get<Array<FjRelease>>(
        auth,
        o.cursor ?? `/repos/${slug}/releases?limit=50`,
        o.cursor ? null : o.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(releaseOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listComments(auth, slug, number) {
      const r = await get<Array<FjComment>>(
        auth,
        `/repos/${slug}/issues/${number}/comments`,
      )
      return r.body.map((c): RemoteComment => ({
        id: String(c.id),
        number,
        body: c.body,
        author: actor(c.user),
        created: toMs(c.created_at) ?? 0,
        updated: toMs(c.updated_at) ?? 0,
      }))
    },

    async pullPatch(auth, slug, number) {
      const res = await f(`${web}/${slug}/pulls/${number}.diff`, {
        headers: headers(auth),
      })
      if (res.status === 404) return null
      if (!res.ok)
        throw new ProviderError(
          id,
          res.status,
          `${cfg.host} answered ${res.status}`,
        )
      return res.text()
    },
  }
  return { forge, oauth }
}

type FjPull = {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  merged?: boolean
  draft?: boolean
  user: FjUser | null
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } | null }
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  html_url: string
}

const pullOf = (p: FjPull): RemotePull => ({
  number: p.number,
  title: p.title,
  body: p.body ?? '',
  state: p.merged || p.merged_at ? 'merged' : p.state,
  draft: p.draft ?? /^(WIP|\[WIP\]|Draft):/i.test(p.title),
  author: actor(p.user),
  head: {
    ref: p.head.ref,
    sha: p.head.sha,
    fromFork: (p.head.repo?.full_name ?? '') !== (p.base.repo?.full_name ?? ''),
  },
  base: { ref: p.base.ref },
  created: toMs(p.created_at) ?? 0,
  updated: toMs(p.updated_at) ?? 0,
  closed: toMs(p.closed_at),
  merged: toMs(p.merged_at),
  url: p.html_url,
})

type FjIssue = {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  user: FjUser | null
  labels: Array<{ name: string }>
  created_at: string
  updated_at: string
  closed_at: string | null
  html_url: string
}

const issueOf = (i: FjIssue): RemoteIssue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  state: i.state,
  author: actor(i.user),
  labels: i.labels.map((l) => l.name),
  created: toMs(i.created_at) ?? 0,
  updated: toMs(i.updated_at) ?? 0,
  closed: toMs(i.closed_at),
  url: i.html_url,
})

type FjRelease = {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  author: FjUser | null
  created_at: string
  published_at: string | null
  html_url: string
}

const releaseOf = (r: FjRelease): RemoteRelease => ({
  id: String(r.id),
  tag: r.tag_name,
  name: r.name || r.tag_name,
  body: r.body ?? '',
  draft: r.draft,
  prerelease: r.prerelease,
  author: actor(r.author),
  created: toMs(r.created_at) ?? 0,
  published: toMs(r.published_at),
  url: r.html_url,
})

type FjComment = {
  id: number
  body: string
  user: FjUser | null
  created_at: string
  updated_at: string
}

export function forgejoEvent(kind: string, body: string): WebhookEvent {
  let e: {
    action?: string
    ref?: string
    repository?: FjRepo
    number?: number
    pull_request?: { number: number }
    issue?: { number: number }
    sender?: FjUser
  }
  try {
    e = JSON.parse(body) as typeof e
  } catch {
    return { kind: 'ignored', reason: 'not JSON' }
  }
  const r = e.repository
  if (!r) return { kind: 'ignored', reason: 'no repository' }
  const repo = String(r.id)
  const slug = r.full_name
  switch (kind) {
    case 'push':
    case 'create':
    case 'delete':
      return { kind: 'push', repo, slug, ref: e.ref ?? '' }
    case 'repository':
      return e.action === 'deleted'
        ? {
            kind: 'repository',
            action: 'deleted',
            repo,
            slug,
            private: r.private,
            archived: r.archived ?? false,
          }
        : { kind: 'ignored', reason: `repository.${e.action}` }
    case 'pull_request':
    case 'issues':
    case 'release':
    case 'issue_comment':
      return {
        kind: kind === 'issue_comment' ? 'comment' : kind,
        action: e.action ?? '',
        repo,
        slug,
        number: e.pull_request?.number ?? e.issue?.number ?? e.number ?? null,
        actor: actor(e.sender),
      }
    default:
      return { kind: 'ignored', reason: kind || 'no event name' }
  }
}
