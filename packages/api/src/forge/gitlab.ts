import { call, toMs } from './http'
import { sameText } from './vault'
import { ProviderError } from './types'
import type {
  ExternalActor,
  Fetch,
  ForgeProvider,
  OAuthTokens,
  ProviderAuth,
  ProviderOAuth,
  RemoteComment,
  RemoteIssue,
  RemotePull,
  RemoteRelease,
  RemoteRepo,
  WebhookEvent,
} from './types'

export type GitlabConfig = {
  clientId: string
  clientSecret: string
  host?: string
  fetch?: Fetch
  now?: () => number
}

type GlUser = {
  id: number
  username: string
  name?: string
  avatar_url?: string
}

type GlProject = {
  id: number
  path_with_namespace: string
  visibility: 'private' | 'internal' | 'public'
  archived?: boolean
  forked_from_project?: unknown
  default_branch?: string | null
  description?: string | null
  star_count?: number
  forks_count?: number
  license?: { key?: string; nickname?: string } | null
  statistics?: { repository_size?: number }
  web_url?: string
  permissions?: {
    project_access?: { access_level: number } | null
    group_access?: { access_level: number } | null
  }
}

const actor = (u: GlUser | null | undefined): ExternalActor | null =>
  u
    ? {
        id: String(u.id),
        login: u.username,
        name: u.name ?? null,
        avatar: u.avatar_url ?? null,
      }
    : null

const level = (p: GlProject) =>
  Math.max(
    p.permissions?.project_access?.access_level ?? 0,
    p.permissions?.group_access?.access_level ?? 0,
  )

export function repoOfGitlab(p: GlProject, host = 'gitlab.com'): RemoteRepo {
  const l = p.permissions ? level(p) : null
  return {
    provider: 'gitlab',
    instance: host,
    id: String(p.id),
    slug: p.path_with_namespace,
    private: p.visibility !== 'public',
    archived: p.archived ?? false,
    fork: Boolean(p.forked_from_project),
    defaultBranch: p.default_branch ?? 'main',
    sizeBytes: p.statistics?.repository_size ?? 0,
    description: p.description ?? '',
    stars: p.star_count ?? 0,
    forks: p.forks_count ?? 0,
    license: p.license?.key ? p.license.key.toUpperCase() : null,
    website: null,
    canPush: l === null ? null : l >= 30,
    canAdmin: l === null ? null : l >= 40,
  }
}

export function createGitlab(cfg: GitlabConfig): {
  forge: ForgeProvider
  oauth: ProviderOAuth
} {
  const host = cfg.host ?? 'gitlab.com'
  const web = `https://${host}`
  const api = `${web}/api/v4`
  const f: Fetch = cfg.fetch ?? ((u, i) => fetch(u, i))
  const now = cfg.now ?? Date.now
  const enc = (slug: string) => encodeURIComponent(slug)

  const headers = (auth: ProviderAuth) => {
    if (auth.kind !== 'user')
      throw new ProviderError(
        'gitlab',
        400,
        'GitLab is reached with a person token.',
        false,
      )
    return {
      authorization: `Bearer ${auth.token}`,
      'user-agent': 'cobaltforge',
    }
  }
  const get = <T>(auth: ProviderAuth, path: string, etag?: string | null) =>
    call<T>('gitlab', f, path.startsWith('http') ? path : `${api}${path}`, {
      headers: headers(auth),
      etag,
    })

  async function token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await f(`${web}/oauth/token`, {
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
      created_at?: number
      scope?: string
      error?: string
      error_description?: string
    }
    if (!res.ok || !j.access_token)
      throw new ProviderError(
        'gitlab',
        res.status,
        `GitLab refused the token request: ${j.error ?? res.status}${j.error_description ? ` (${j.error_description})` : ''}`,
        res.status === 400 || res.status === 401,
      )
    const start = j.created_at ? j.created_at * 1000 : now()
    return {
      access: j.access_token,
      refresh: j.refresh_token ?? null,
      expiresAt: j.expires_in ? start + j.expires_in * 1000 : null,
      scopes: (j.scope ?? '').split(/[ ,]+/).filter(Boolean),
    }
  }

  const oauth: ProviderOAuth = {
    id: 'gitlab',
    scopes: ['api'],
    authorizeUrl: (state, redirectUri) =>
      `${web}/oauth/authorize?${new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        scope: 'api',
      })}`,
    exchange: (code, redirectUri) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async revoke(t) {
      await f(`${web}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          token: t,
        }).toString(),
      })
    },
    async whoami(t) {
      const r = await get<GlUser>({ kind: 'user', token: t }, '/user')
      return { id: String(r.body.id), login: r.body.username }
    },
  }

  const forge: ForgeProvider = {
    id: 'gitlab',
    host,
    capabilities: {
      mode: 'generic',
      lfs: false,
      webhooks: 'repo',
      signature: 'token',
      refreshRotates: true,
    },

    async listRepos(auth, o) {
      const per = Math.min(o.perPage ?? 100, 100)
      const r = await get<Array<GlProject>>(
        auth,
        o.cursor ??
          `/projects?membership=true&min_access_level=30&per_page=${per}&order_by=last_activity_at&simple=false`,
      )
      return { items: r.body.map((p) => repoOfGitlab(p, host)), next: r.next }
    },

    async getRepo(auth, slug) {
      const r = await get<GlProject>(
        auth,
        `/projects/${enc(slug)}?license=true&statistics=true`,
      ).catch(async (e: unknown) => {
        if (e instanceof ProviderError && e.status === 403)
          return get<GlProject>(auth, `/projects/${enc(slug)}?license=true`)
        throw e
      })
      return repoOfGitlab(r.body, host)
    },

    async languages(auth, slug) {
      const r = await get<Record<string, number>>(
        auth,
        `/projects/${enc(slug)}/languages`,
      )
      return Object.entries(r.body)
        .map(([k, pct]): [string, number] => [k, Math.round(pct * 1000)])
        .sort((a, b) => b[1] - a[1])
    },

    async readFile(auth, slug, path) {
      const res = await f(
        `${api}/projects/${enc(slug)}/repository/files/${encodeURIComponent(path)}/raw?ref=HEAD`,
        { headers: headers(auth) },
      )
      if (res.status === 404) return null
      if (!res.ok)
        throw new ProviderError(
          'gitlab',
          res.status,
          `gitlab answered ${res.status}`,
        )
      return res.text()
    },

    gitCredential: (auth) =>
      auth.kind === 'user'
        ? { username: 'oauth2', password: auth.token }
        : null,

    async createWebhook(auth, slug, hook) {
      const r = await call<{ id: number }>(
        'gitlab',
        f,
        `${api}/projects/${enc(slug)}/hooks`,
        {
          method: 'POST',
          headers: headers(auth),
          body: {
            url: hook.url,
            token: hook.secret,
            push_events: true,
            tag_push_events: true,
            merge_requests_events: true,
            issues_events: true,
            note_events: true,
            releases_events: true,
            enable_ssl_verification: true,
          },
        },
      )
      return { id: String(r.body.id) }
    },

    async deleteWebhook(auth, slug, id) {
      try {
        await call('gitlab', f, `${api}/projects/${enc(slug)}/hooks/${id}`, {
          method: 'DELETE',
          headers: headers(auth),
        })
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) throw e
      }
    },

    verifyWebhook: (h, _body, secret) =>
      Promise.resolve(sameText(h.get('x-gitlab-token') ?? '', secret)),

    parseWebhook(h, body) {
      return {
        id:
          h.get('x-gitlab-event-uuid') ??
          h.get('idempotency-key') ??
          h.get('x-gitlab-webhook-uuid') ??
          '',
        event: gitlabEvent(h.get('x-gitlab-event') ?? '', body),
      }
    },

    async listPulls(auth, slug, o) {
      const r = await get<Array<GlMr>>(
        auth,
        o.cursor ??
          `/projects/${enc(slug)}/merge_requests?state=all&per_page=100&order_by=updated_at`,
        o.cursor ? null : o.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(mrOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listIssues(auth, slug, o) {
      const r = await get<Array<GlIssue>>(
        auth,
        o.cursor ??
          `/projects/${enc(slug)}/issues?state=all&per_page=100&order_by=updated_at`,
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
      const r = await get<Array<GlRelease>>(
        auth,
        o.cursor ?? `/projects/${enc(slug)}/releases?per_page=100`,
        o.cursor ? null : o.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(releaseOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listLabels(auth, slug) {
      const r = await get<
        Array<{ name: string; color?: string; description?: string | null }>
      >(auth, `/projects/${enc(slug)}/labels?per_page=100`)
      return r.body.map((l) => ({
        name: l.name,
        color: (l.color ?? '').replace(/^#/, ''),
        description: l.description ?? '',
      }))
    },

    async listComments(auth, slug, number, on = 'issue') {
      const out: Array<RemoteComment> = []
      let url: string | null =
        `/projects/${enc(slug)}/${on === 'pull' ? 'merge_requests' : 'issues'}/${number}/notes?per_page=100&sort=asc`
      while (url) {
        const r: Awaited<ReturnType<typeof get<Array<GlNote>>>> = await get(
          auth,
          url,
        )
        for (const n of r.body)
          if (!n.system)
            out.push({
              id: String(n.id),
              number,
              body: n.body,
              author: actor(n.author),
              created: toMs(n.created_at) ?? 0,
              updated: toMs(n.updated_at) ?? 0,
            })
        url = r.next
      }
      return out
    },

    async pullPatch(auth, slug, number) {
      try {
        const r = await get<{
          changes: Array<{
            old_path: string
            new_path: string
            diff: string
            new_file: boolean
            deleted_file: boolean
          }>
        }>(auth, `/projects/${enc(slug)}/merge_requests/${number}/changes`)
        return r.body.changes
          .map((c) => {
            const a = c.new_file ? '/dev/null' : `a/${c.old_path}`
            const b = c.deleted_file ? '/dev/null' : `b/${c.new_path}`
            const mode = c.new_file
              ? 'new file mode 100644\n'
              : c.deleted_file
                ? 'deleted file mode 100644\n'
                : ''
            return `diff --git a/${c.old_path} b/${c.new_path}\n${mode}--- ${a}\n+++ ${b}\n${c.diff}`
          })
          .join('')
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) return null
        throw e
      }
    },
  }
  return { forge, oauth }
}

type GlMr = {
  iid: number
  title: string
  description: string | null
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  work_in_progress?: boolean
  author: GlUser | null
  sha: string
  source_branch: string
  target_branch: string
  source_project_id: number
  target_project_id: number
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  web_url: string
  labels?: Array<string>
}

const mrOf = (m: GlMr): RemotePull => ({
  number: m.iid,
  title: m.title,
  body: m.description ?? '',
  state:
    m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
  draft: m.draft ?? m.work_in_progress ?? false,
  author: actor(m.author),
  labels: m.labels ?? [],
  head: {
    ref: m.source_branch,
    sha: m.sha,
    fromFork: m.source_project_id !== m.target_project_id,
  },
  base: { ref: m.target_branch },
  created: toMs(m.created_at) ?? 0,
  updated: toMs(m.updated_at) ?? 0,
  closed: toMs(m.closed_at),
  merged: toMs(m.merged_at),
  url: m.web_url,
})

type GlIssue = {
  iid: number
  title: string
  description: string | null
  state: 'opened' | 'closed'
  author: GlUser | null
  labels: Array<string>
  assignees?: Array<GlUser> | null
  created_at: string
  updated_at: string
  closed_at: string | null
  web_url: string
}

const issueOf = (i: GlIssue): RemoteIssue => ({
  number: i.iid,
  title: i.title,
  body: i.description ?? '',
  state: i.state === 'opened' ? 'open' : 'closed',
  author: actor(i.author),
  labels: i.labels,
  closedAs: i.state === 'closed' ? 'completed' : null,
  assignees: (i.assignees ?? [])
    .map((u) => actor(u))
    .filter((a): a is NonNullable<typeof a> => a !== null),
  created: toMs(i.created_at) ?? 0,
  updated: toMs(i.updated_at) ?? 0,
  closed: toMs(i.closed_at),
  url: i.web_url,
})

type GlRelease = {
  tag_name: string
  name: string | null
  description: string | null
  author: GlUser | null
  created_at: string
  released_at: string | null
  upcoming_release?: boolean
  _links?: { self?: string }
  assets?: {
    links?: Array<{ name: string; url: string; direct_asset_url?: string }>
  }
}

const releaseOf = (r: GlRelease): RemoteRelease => ({
  id: r.tag_name,
  tag: r.tag_name,
  name: r.name ?? r.tag_name,
  body: r.description ?? '',
  draft: false,
  prerelease: r.upcoming_release ?? false,
  author: actor(r.author),
  created: toMs(r.created_at) ?? 0,
  published: toMs(r.released_at),
  url: r._links?.self ?? '',
  // GitLab keeps no size or count for release links.
  assets: (r.assets?.links ?? []).map((l) => ({
    name: l.name,
    size: 0,
    downloads: 0,
    url: l.direct_asset_url ?? l.url,
    sha256: null,
  })),
})

type GlNote = {
  id: number
  body: string
  system?: boolean
  author: GlUser | null
  created_at: string
  updated_at: string
}

export function gitlabEvent(kind: string, body: string): WebhookEvent {
  let e: {
    object_kind?: string
    project?: { id: number; path_with_namespace: string }
    project_id?: number
    ref?: string
    user?: GlUser
    object_attributes?: {
      iid?: number
      action?: string
      noteable_type?: string
    }
    merge_request?: { iid: number }
    issue?: { iid: number }
    action?: string
    tag?: string
  }
  try {
    e = JSON.parse(body) as typeof e
  } catch {
    return { kind: 'ignored', reason: 'not JSON' }
  }
  const repo = String(e.project?.id ?? e.project_id ?? '')
  const slug = e.project?.path_with_namespace ?? ''
  if (!repo) return { kind: 'ignored', reason: 'no project' }
  switch (kind) {
    case 'Push Hook':
    case 'Tag Push Hook':
      return { kind: 'push', repo, slug, ref: e.ref ?? '' }
    case 'Merge Request Hook':
      return {
        kind: 'pull_request',
        action: e.object_attributes?.action ?? '',
        repo,
        slug,
        number: e.object_attributes?.iid ?? null,
        actor: actor(e.user),
      }
    case 'Issue Hook':
      return {
        kind: 'issues',
        action: e.object_attributes?.action ?? '',
        repo,
        slug,
        number: e.object_attributes?.iid ?? null,
        actor: actor(e.user),
      }
    case 'Release Hook':
      return {
        kind: 'release',
        action: e.action ?? '',
        repo,
        slug,
        number: null,
        actor: null,
      }
    case 'Note Hook':
      return {
        kind: 'comment',
        action: 'created',
        repo,
        slug,
        number: e.merge_request?.iid ?? e.issue?.iid ?? null,
        actor: actor(e.user),
      }
    default:
      return { kind: 'ignored', reason: kind || 'no event name' }
  }
}
