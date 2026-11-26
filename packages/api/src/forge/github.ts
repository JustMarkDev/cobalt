import { SignJWT, importPKCS8 } from 'jose'
import { createPrivateKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { call, toMs } from './http'
import { hmacHex, sameText } from './vault'
import { ProviderError } from './types'
import type {
  Delivery,
  ExternalActor,
  Fetch,
  ForgeProvider,
  ProviderAuth,
  RemoteCheck,
  RemoteComment,
  RemoteIssue,
  RemoteLabel,
  RemotePull,
  RemoteRelease,
  RemoteRepo,
  RemoteReview,
  RemoteReviewComment,
  WebhookEvent,
} from './types'

const API = 'https://api.github.com'
const base = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'cobaltforge',
}

export type GithubAppConfig = {
  appId: string
  privateKey: string
  webhookSecret: string | null
}

export function githubAppFromEnv(
  env: Record<string, string | undefined>,
): GithubAppConfig | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET ?? null,
  }
}

export class AppTokens {
  private key: Promise<CryptoKey | KeyObject> | undefined
  private readonly cache = new Map<number, { token: string; until: number }>()
  private readonly pending = new Map<number, Promise<string>>()

  constructor(
    private readonly cfg: GithubAppConfig,
    private readonly f: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private signingKey() {
    this.key ??= (async () => {
      const pem = this.cfg.privateKey.replace(/\\n/g, '\n')
      return pem.includes('BEGIN PRIVATE KEY')
        ? importPKCS8(pem, 'RS256')
        : createPrivateKey(pem)
    })()
    return this.key
  }

  async jwt() {
    const at = Math.floor(this.now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(at - 60)
      .setExpirationTime(at + 540)
      .setIssuer(this.cfg.appId)
      .sign(await this.signingKey())
  }

  async token(installation: number): Promise<string> {
    const hit = this.cache.get(installation)
    if (hit && hit.until > this.now()) return hit.token
    const running = this.pending.get(installation)
    if (running) return running
    const p = (async () => {
      const r = await call<{ token: string; expires_at: string }>(
        'github',
        this.f,
        `${API}/app/installations/${installation}/access_tokens`,
        {
          method: 'POST',
          headers: { ...base, authorization: `Bearer ${await this.jwt()}` },
        },
      )
      const until = (toMs(r.body.expires_at) ?? this.now()) - 5 * 60_000
      this.cache.set(installation, { token: r.body.token, until })
      return r.body.token
    })().finally(() => this.pending.delete(installation))
    this.pending.set(installation, p)
    return p
  }

  async installationOf(slug: string): Promise<number | null> {
    try {
      const r = await call<{ id: number }>(
        'github',
        this.f,
        `${API}/repos/${slug}/installation`,
        { headers: { ...base, authorization: `Bearer ${await this.jwt()}` } },
      )
      return r.body.id
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null
      throw e
    }
  }

  forget(installation: number) {
    this.cache.delete(installation)
  }
}

type GhUser = { id: number; login: string; avatar_url?: string; name?: string }
type GhRepo = {
  id: number
  full_name: string
  private: boolean
  archived?: boolean
  fork?: boolean
  default_branch: string
  size?: number
  description?: string | null
  stargazers_count?: number
  forks_count?: number
  homepage?: string | null
  license?: { spdx_id?: string | null } | null
  permissions?: { admin?: boolean; push?: boolean }
}

const actor = (u: GhUser | null | undefined): ExternalActor | null =>
  u
    ? {
        id: String(u.id),
        login: u.login,
        name: u.name ?? null,
        avatar: u.avatar_url ?? null,
      }
    : null

export function repoOfGithub(r: GhRepo, installation?: number): RemoteRepo {
  const spdx = r.license?.spdx_id ?? null
  return {
    provider: 'github',
    instance: 'github.com',
    id: String(r.id),
    slug: r.full_name,
    private: r.private,
    archived: r.archived ?? false,
    fork: r.fork ?? false,
    defaultBranch: r.default_branch,
    sizeBytes: (r.size ?? 0) * 1024,
    description: r.description ?? '',
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    license: spdx && spdx !== 'NOASSERTION' ? spdx : null,
    website: r.homepage || null,
    canPush: r.permissions
      ? Boolean(r.permissions.push || r.permissions.admin)
      : null,
    canAdmin: r.permissions ? Boolean(r.permissions.admin) : null,
    ...(installation === undefined ? {} : { installation }),
  }
}

export type GithubForge = ForgeProvider & {
  readonly tokens: AppTokens | null
  userInstallations: (token: string) => Promise<Array<number>>
  pushable: (token: string) => Promise<Map<string, RemoteRepo>>
}

export function createGithubForge(
  o: {
    app?: GithubAppConfig | null
    fetch?: Fetch
    now?: () => number
    installationToken?: (installation: number) => Promise<string>
  } = {},
): GithubForge {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i))
  const tokens = o.app ? new AppTokens(o.app, f, o.now) : null
  const installationToken =
    o.installationToken ?? (tokens ? (i: number) => tokens.token(i) : null)

  async function headers(auth: ProviderAuth) {
    if (auth.kind === 'user')
      return { ...base, authorization: `Bearer ${auth.token}` }
    if (!installationToken)
      throw new ProviderError(
        'github',
        503,
        'The GitHub App is not configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.',
        false,
      )
    return {
      ...base,
      authorization: `token ${await installationToken(auth.installation)}`,
    }
  }

  const get = async <T>(
    auth: ProviderAuth,
    url: string,
    etag?: string | null,
  ) =>
    call<T>('github', f, url.startsWith('http') ? url : `${API}${url}`, {
      headers: await headers(auth),
      etag,
    })

  async function userInstallations(token: string) {
    const out: Array<number> = []
    let url: string | null = `${API}/user/installations?per_page=100`
    while (url) {
      const r: Awaited<
        ReturnType<typeof get<{ installations: Array<{ id: number }> }>>
      > = await get({ kind: 'user', token }, url)
      out.push(...r.body.installations.map((i) => i.id))
      url = r.next
    }
    return out
  }

  type Cursor = { i: number; url: string | null; ids: Array<number> }
  const enc = (c: Cursor) =>
    Buffer.from(JSON.stringify(c)).toString('base64url')
  const dec = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor

  const forge: GithubForge = {
    id: 'github',
    host: 'github.com',
    tokens,
    capabilities: {
      mode: 'app',
      lfs: true,
      webhooks: 'app',
      signature: 'hmac-sha256',
      refreshRotates: false,
    },
    userInstallations,

    async listRepos(auth, opts) {
      const per = Math.min(opts.perPage ?? 100, 100)
      if (auth.kind === 'installation') {
        const r = await get<{ repositories: Array<GhRepo> }>(
          auth,
          opts.cursor ?? `/installation/repositories?per_page=${per}`,
        )
        return {
          items: r.body.repositories.map((x) =>
            repoOfGithub(x, auth.installation),
          ),
          next: r.next,
        }
      }
      const c: Cursor = opts.cursor
        ? dec(opts.cursor)
        : { i: 0, url: null, ids: await userInstallations(auth.token) }
      if (c.i >= c.ids.length) return { items: [], next: null }
      const inst = c.ids[c.i]
      const r = await get<{ repositories: Array<GhRepo> }>(
        auth,
        c.url ?? `/user/installations/${inst}/repositories?per_page=${per}`,
      )
      const next: Cursor = r.next
        ? { ...c, url: r.next }
        : { ...c, i: c.i + 1, url: null }
      return {
        items: r.body.repositories.map((x) => repoOfGithub(x, inst)),
        next: next.i < next.ids.length ? enc(next) : null,
      }
    },

    async pushable(token) {
      const out = new Map<string, RemoteRepo>()
      let cursor: string | null = null
      do {
        const page = await forge.listRepos({ kind: 'user', token }, { cursor })
        for (const r of page.items)
          if (r.canPush) out.set(r.slug.toLowerCase(), r)
        cursor = page.next
      } while (cursor)
      return out
    },

    async getRepo(auth, slug) {
      const r = await get<GhRepo>(auth, `/repos/${slug}`)
      return repoOfGithub(
        r.body,
        auth.kind === 'installation' ? auth.installation : undefined,
      )
    },

    async languages(auth, slug) {
      const r = await get<Record<string, number>>(
        auth,
        `/repos/${slug}/languages`,
      )
      return Object.entries(r.body).sort((a, b) => b[1] - a[1])
    },

    async readFile(auth, slug, path) {
      try {
        const r = await get<{ content?: string; encoding?: string }>(
          auth,
          `/repos/${slug}/contents/${path}`,
        )
        return r.body.content && r.body.encoding === 'base64'
          ? Buffer.from(r.body.content, 'base64').toString('utf8')
          : null
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) return null
        throw e
      }
    },

    installationOf: (slug) =>
      tokens ? tokens.installationOf(slug) : Promise.resolve(null),
    gitCredential: () => null,

    async createRepo(auth, repo) {
      const me = await get<{ login: string }>(auth, '/user')
      const mine = me.body.login.toLowerCase() === repo.owner.toLowerCase()
      const r = await call<GhRepo>(
        'github',
        f,
        mine ? `${API}/user/repos` : `${API}/orgs/${repo.owner}/repos`,
        {
          method: 'POST',
          headers: await headers(auth),
          body: {
            name: repo.name,
            private: repo.private,
            description: repo.description,
            auto_init: false,
            has_wiki: false,
          },
        },
      )
      return repoOfGithub(r.body)
    },

    async createWebhook(auth, slug, hook) {
      const r = await call<{ id: number }>(
        'github',
        f,
        `${API}/repos/${slug}/hooks`,
        {
          method: 'POST',
          headers: await headers(auth),
          body: {
            name: 'web',
            active: true,
            events: ['push', 'repository', 'pull_request', 'issues', 'release'],
            config: {
              url: hook.url,
              content_type: 'json',
              secret: hook.secret,
              insecure_ssl: '0',
            },
          },
        },
      )
      return { id: String(r.body.id) }
    },

    async deleteWebhook(auth, slug, id) {
      try {
        await call('github', f, `${API}/repos/${slug}/hooks/${id}`, {
          method: 'DELETE',
          headers: await headers(auth),
        })
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) throw e
      }
    },

    async verifyWebhook(h, body, secret) {
      const sig = h.get('x-hub-signature-256') ?? ''
      if (!sig.startsWith('sha256=')) return false
      return sameText(sig.slice(7), await hmacHex(secret, body))
    },

    parseWebhook(h, body) {
      return {
        id: h.get('x-github-delivery') ?? '',
        event: githubEvent(h.get('x-github-event') ?? '', body),
      }
    },

    async listPulls(auth, slug, q) {
      const r = await get<Array<GhPull>>(
        auth,
        q.cursor ??
          `/repos/${slug}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
        q.cursor ? null : q.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(pullOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listIssues(auth, slug, q) {
      const r = await get<Array<GhIssue>>(
        auth,
        q.cursor ??
          `/repos/${slug}/issues?state=all&per_page=100&sort=updated&direction=desc`,
        q.cursor ? null : q.etag,
      )
      return {
        items: r.notModified
          ? []
          : r.body.filter((i) => !i.pull_request).map(issueOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async listReleases(auth, slug, q) {
      const r = await get<Array<GhRelease>>(
        auth,
        q.cursor ?? `/repos/${slug}/releases?per_page=100`,
        q.cursor ? null : q.etag,
      )
      return {
        items: r.notModified ? [] : r.body.map(releaseOf),
        etag: r.etag,
        notModified: r.notModified,
        next: r.next,
      }
    },

    async createPull(auth, slug, pr) {
      const owner = slug.split('/')[0]
      const open = await get<Array<GhPull>>(
        auth,
        `/repos/${slug}/pulls?${new URLSearchParams({ head: `${owner}:${pr.head}`, state: 'open' })}`,
      )
      if (open.body[0]) return pullOf(open.body[0])
      const r = await call<GhPull>('github', f, `${API}/repos/${slug}/pulls`, {
        method: 'POST',
        headers: await headers(auth),
        body: pr,
      })
      return pullOf(r.body)
    },

    async createIssue(auth, slug, issue) {
      const r = await call<GhIssue>(
        'github',
        f,
        `${API}/repos/${slug}/issues`,
        {
          method: 'POST',
          headers: await headers(auth),
          body: issue,
        },
      )
      return issueOf(r.body)
    },

    async recentIssuesBy(auth, slug, login, since) {
      const q = new URLSearchParams({
        creator: login,
        state: 'open',
        since: new Date(since).toISOString(),
        sort: 'created',
        per_page: '30',
      })
      const r = await get<Array<GhIssue>>(auth, `/repos/${slug}/issues?${q}`)
      return r.body.filter((i) => !i.pull_request).map(issueOf)
    },

    async getIssue(auth, slug, number) {
      return issueOf(
        (await get<GhIssue>(auth, `/repos/${slug}/issues/${number}`)).body,
      )
    },

    async updateIssue(auth, slug, number, patch) {
      const r = await call<GhIssue>(
        'github',
        f,
        `${API}/repos/${slug}/issues/${number}`,
        { method: 'PATCH', headers: await headers(auth), body: patch },
      )
      return issueOf(r.body)
    },

    async createComment(auth, slug, number, body) {
      const r = await call<{ id: number }>(
        'github',
        f,
        `${API}/repos/${slug}/issues/${number}/comments`,
        { method: 'POST', headers: await headers(auth), body: { body } },
      )
      return { id: String(r.body.id) }
    },

    async listComments(auth, slug, number) {
      const out: Array<RemoteComment> = []
      let url: string | null =
        `/repos/${slug}/issues/${number}/comments?per_page=100`
      while (url) {
        const r: Awaited<ReturnType<typeof get<Array<GhComment>>>> = await get(
          auth,
          url,
        )
        out.push(
          ...r.body.map((c) => ({
            id: String(c.id),
            number,
            body: c.body ?? '',
            author: actor(c.user),
            created: toMs(c.created_at) ?? 0,
            updated: toMs(c.updated_at) ?? 0,
          })),
        )
        url = r.next
      }
      return out
    },

    async listLabels(auth, slug) {
      const out: Array<RemoteLabel> = []
      let url: string | null = `/repos/${slug}/labels?per_page=100`
      for (let page = 0; url && page < 10; page++) {
        const r: Awaited<ReturnType<typeof get<Array<GhLabel>>>> = await get(
          auth,
          url,
        )
        for (const l of r.body)
          out.push({
            name: l.name,
            color: l.color ?? '',
            description: l.description ?? '',
          })
        url = r.next
      }
      return out
    },

    async listReviews(auth, slug, number) {
      const out: Array<RemoteReview> = []
      let url: string | null =
        `/repos/${slug}/pulls/${number}/reviews?per_page=100`
      for (let page = 0; url && page < 10; page++) {
        const r: Awaited<ReturnType<typeof get<Array<GhReview>>>> = await get(
          auth,
          url,
        )
        for (const x of r.body) {
          const state = reviewState(x.state)
          if (!state || !x.submitted_at) continue
          out.push({
            id: String(x.id),
            author: actor(x.user),
            state,
            body: x.body ?? '',
            sha: x.commit_id ?? null,
            created: toMs(x.submitted_at) ?? 0,
          })
        }
        url = r.next
      }
      return out
    },

    async listReviewComments(auth, slug, number) {
      const out: Array<RemoteReviewComment> = []
      let url: string | null =
        `/repos/${slug}/pulls/${number}/comments?per_page=100`
      for (let page = 0; url && page < 10; page++) {
        const r: Awaited<ReturnType<typeof get<Array<GhReviewComment>>>> =
          await get(auth, url)
        for (const c of r.body)
          out.push({
            id: String(c.id),
            author: actor(c.user),
            body: c.body ?? '',
            path: c.path,
            line: c.line ?? c.original_line ?? null,
            replyTo:
              c.in_reply_to_id === undefined || c.in_reply_to_id === null
                ? null
                : String(c.in_reply_to_id),
            created: toMs(c.created_at) ?? 0,
            updated: toMs(c.updated_at) ?? 0,
          })
        url = r.next
      }
      return out
    },

    async checksOf(auth, slug, sha) {
      const out: Array<RemoteCheck> = []
      const runs = await get<{
        check_runs: Array<{
          id: number
          name: string
          status: string
          conclusion: string | null
          html_url: string | null
          started_at: string | null
          completed_at: string | null
        }>
      }>(auth, `/repos/${slug}/commits/${sha}/check-runs?per_page=100`)
      for (const c of runs.body.check_runs)
        out.push({
          id: `run_${c.id}`,
          name: c.name,
          state:
            c.status !== 'completed'
              ? 'pending'
              : ['success', 'neutral', 'skipped'].includes(c.conclusion ?? '')
                ? 'pass'
                : 'fail',
          url: c.html_url,
          created: toMs(c.started_at) ?? 0,
          updated: toMs(c.completed_at ?? c.started_at) ?? 0,
        })
      const st = await get<{
        statuses: Array<{
          id: number
          context: string
          state: 'pending' | 'success' | 'failure' | 'error'
          target_url: string | null
          created_at: string
          updated_at: string
        }>
      }>(auth, `/repos/${slug}/commits/${sha}/status`)
      for (const c of st.body.statuses)
        out.push({
          id: `status_${c.context}`,
          name: c.context,
          state:
            c.state === 'success'
              ? 'pass'
              : c.state === 'pending'
                ? 'pending'
                : 'fail',
          url: c.target_url,
          created: toMs(c.created_at) ?? 0,
          updated: toMs(c.updated_at) ?? 0,
        })
      return out
    },

    async secretNames(auth, slug) {
      const out: Array<{ name: string; environment: string | null }> = []
      const repo = await get<{ secrets: Array<{ name: string }> }>(
        auth,
        `/repos/${slug}/actions/secrets?per_page=100`,
      )
      for (const s of repo.body.secrets)
        out.push({ name: s.name, environment: null })
      const envs = await get<{ environments?: Array<{ name: string }> }>(
        auth,
        `/repos/${slug}/environments?per_page=100`,
      ).catch(() => ({ body: { environments: [] } }))
      for (const e of envs.body.environments ?? []) {
        const r = await get<{ secrets: Array<{ name: string }> }>(
          auth,
          `/repos/${slug}/environments/${encodeURIComponent(e.name)}/secrets?per_page=100`,
        ).catch(() => ({ body: { secrets: [] } }))
        for (const s of r.body.secrets)
          out.push({ name: s.name, environment: e.name })
      }
      return out
    },

    async pullFiles(auth, slug, number) {
      const out: Record<string, { add: number; del: number }> = {}
      let url: string | null =
        `/repos/${slug}/pulls/${number}/files?per_page=100`
      for (let page = 0; url && page < 30; page++) {
        const r: Awaited<
          ReturnType<
            typeof get<
              Array<{ filename: string; additions: number; deletions: number }>
            >
          >
        > = await get(auth, url)
        for (const file of r.body)
          out[file.filename] = { add: file.additions, del: file.deletions }
        url = r.next
      }
      return out
    },

    async pullPatch(auth, slug, number) {
      const res = await f(`${API}/repos/${slug}/pulls/${number}`, {
        headers: {
          ...(await headers(auth)),
          accept: 'application/vnd.github.diff',
        },
      })
      if (res.status === 404 || res.status === 406) return null
      if (!res.ok)
        throw new ProviderError(
          'github',
          res.status,
          `github answered ${res.status}`,
        )
      return res.text()
    },
  }
  return forge
}

type GhPull = {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
  html_url: string
  user: GhUser | null
  labels?: Array<{ name?: string } | string>
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } }
}

const pullOf = (p: GhPull): RemotePull => ({
  number: p.number,
  title: p.title,
  body: p.body ?? '',
  state: p.merged_at ? 'merged' : p.state,
  draft: p.draft ?? false,
  author: actor(p.user),
  labels: labelNames(p.labels ?? []),
  head: {
    ref: p.head.ref,
    sha: p.head.sha,
    fromFork: p.head.repo?.full_name !== p.base.repo.full_name,
  },
  base: { ref: p.base.ref },
  created: toMs(p.created_at) ?? 0,
  updated: toMs(p.updated_at) ?? 0,
  closed: toMs(p.closed_at),
  merged: toMs(p.merged_at),
  url: p.html_url,
})

type GhIssue = {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  user: GhUser | null
  labels: Array<{ name?: string } | string>
  created_at: string
  updated_at: string
  closed_at: string | null
  html_url: string
  pull_request?: unknown
  state_reason?: string | null
  assignees?: Array<GhUser> | null
}

const issueOf = (i: GhIssue): RemoteIssue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  state: i.state,
  author: actor(i.user),
  labels: labelNames(i.labels),
  closedAs:
    i.state !== 'closed'
      ? null
      : i.state_reason === 'not_planned'
        ? 'not_planned'
        : i.state_reason === 'duplicate'
          ? 'duplicate'
          : 'completed',
  assignees: (i.assignees ?? [])
    .map((u) => actor(u))
    .filter((a): a is ExternalActor => a !== null),
  created: toMs(i.created_at) ?? 0,
  updated: toMs(i.updated_at) ?? 0,
  closed: toMs(i.closed_at),
  url: i.html_url,
})

type GhRelease = {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  author: GhUser | null
  created_at: string
  published_at: string | null
  html_url: string
  assets?: Array<{
    name: string
    size: number
    download_count: number
    browser_download_url: string
    digest?: string | null
  }>
}

const releaseOf = (r: GhRelease): RemoteRelease => ({
  id: String(r.id),
  tag: r.tag_name,
  name: r.name ?? r.tag_name,
  body: r.body ?? '',
  draft: r.draft,
  prerelease: r.prerelease,
  author: actor(r.author),
  created: toMs(r.created_at) ?? 0,
  published: toMs(r.published_at),
  url: r.html_url,
  assets: (r.assets ?? []).map((a) => ({
    name: a.name,
    size: a.size,
    downloads: a.download_count,
    url: a.browser_download_url,
    sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null,
  })),
})

type GhLabel = { name: string; color?: string; description?: string | null }

type GhReview = {
  id: number
  user: GhUser | null
  body: string | null
  state: string
  commit_id?: string | null
  submitted_at?: string | null
}

const reviewState = (s: string): RemoteReview['state'] | null =>
  s === 'APPROVED'
    ? 'approved'
    : s === 'CHANGES_REQUESTED'
      ? 'changes'
      : s === 'COMMENTED' || s === 'DISMISSED'
        ? 'commented'
        : null

type GhReviewComment = {
  id: number
  user: GhUser | null
  body: string | null
  path: string
  line?: number | null
  original_line?: number | null
  in_reply_to_id?: number | null
  created_at: string
  updated_at: string
}

const labelNames = (ls: Array<{ name?: string } | string>) =>
  ls.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)

type GhComment = {
  id: number
  body: string | null
  user: GhUser | null
  created_at: string
  updated_at: string
}

export function githubEvent(kind: string, body: string): WebhookEvent {
  let e: {
    action?: string
    repository?: GhRepo & { archived?: boolean }
    installation?: { id: number }
    repositories?: Array<{ id: number }>
    repositories_added?: Array<{ id: number }>
    repositories_removed?: Array<{ id: number }>
    ref?: string
    number?: number
    issue?: { number: number }
    pull_request?: { number: number }
    sender?: GhUser
  }
  try {
    e = JSON.parse(body) as typeof e
  } catch {
    return { kind: 'ignored', reason: 'not JSON' }
  }
  const repo = e.repository
  switch (kind) {
    case 'ping':
      return { kind: 'ignored', reason: 'ping' }
    case 'push':
      if (!repo) return { kind: 'ignored', reason: 'push without a repository' }
      return {
        kind: 'push',
        repo: String(repo.id),
        slug: repo.full_name,
        ref: e.ref ?? '',
      }
    case 'repository': {
      if (!repo) return { kind: 'ignored', reason: 'no repository' }
      const map: Partial<
        Record<string, Extract<WebhookEvent, { kind: 'repository' }>['action']>
      > = {
        renamed: 'renamed',
        transferred: 'transferred',
        archived: 'archived',
        unarchived: 'unarchived',
        deleted: 'deleted',
        publicized: 'visibility',
        privatized: 'visibility',
        edited: 'edited',
      }
      const action = map[e.action ?? '']
      if (!action) return { kind: 'ignored', reason: `repository.${e.action}` }
      return {
        kind: 'repository',
        action,
        repo: String(repo.id),
        slug: repo.full_name,
        private: repo.private,
        archived: repo.archived ?? false,
      }
    }
    case 'installation':
    case 'installation_repositories': {
      if (!e.installation) return { kind: 'ignored', reason: 'no installation' }
      const action = e.action as
        | 'created'
        | 'deleted'
        | 'suspend'
        | 'unsuspend'
        | 'added'
        | 'removed'
      if (
        ![
          'created',
          'deleted',
          'suspend',
          'unsuspend',
          'added',
          'removed',
        ].includes(action)
      )
        return { kind: 'ignored', reason: `${kind}.${e.action}` }
      const ids = (xs?: Array<{ id: number }>) =>
        (xs ?? []).map((x) => String(x.id))
      return {
        kind: 'installation',
        action,
        installation: e.installation.id,
        added: ids(
          e.repositories_added ?? (action === 'created' ? e.repositories : []),
        ),
        removed: ids(
          e.repositories_removed ??
            (action === 'deleted' ? e.repositories : []),
        ),
      }
    }
    case 'check_run':
    case 'check_suite':
    case 'status':
      if (!repo) return { kind: 'ignored', reason: 'no repository' }
      return {
        kind: 'checks',
        action: e.action ?? kind,
        repo: String(repo.id),
        slug: repo.full_name,
        number: null,
        actor: null,
      }
    case 'pull_request':
    case 'issues':
    case 'release':
    case 'issue_comment':
      if (!repo) return { kind: 'ignored', reason: 'no repository' }
      return {
        kind: kind === 'issue_comment' ? 'comment' : kind,
        action: e.action ?? '',
        repo: String(repo.id),
        slug: repo.full_name,
        number: e.pull_request?.number ?? e.issue?.number ?? e.number ?? null,
        actor: actor(e.sender),
      }
    default:
      return { kind: 'ignored', reason: kind || 'no event name' }
  }
}

export type { Delivery }
