import { describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { FakeStores } from '@cobaltforge/git/fake'
import { CredentialExists } from '@cobaltforge/git/stores'
import { TokenVault, VaultError, webhookSecret } from './vault'
import { createGithubForge, githubEvent } from './github'
import { createGitlab, gitlabEvent } from './gitlab'
import { createForgejo, forgejoEvent } from './forgejo'
import { nextLink } from './http'
import { percents, upstreamOf } from './sync'
import { ProviderError } from './types'
import type { EnvVarRec } from '../extras'

const user = { kind: 'user' as const, token: 'tok' }

function scripted(
  routes: Partial<
    Record<string, (req: { url: string; init?: RequestInit }) => Response>
  >,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f = (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const u = new URL(url)
    const key = `${init?.method ?? 'GET'} ${u.pathname}${u.search}`
    const hit =
      routes[key] ??
      routes[`${init?.method ?? 'GET'} ${u.pathname}`] ??
      (() => new Response('nope', { status: 404 }))
    return Promise.resolve(hit({ url, init }))
  }
  return { f, calls }
}

describe('the token vault', () => {
  test('seals and opens in the same slot, never in another', async () => {
    const v = await TokenVault.ephemeral('k1')
    const slot = { kind: 'providerConnection', id: 'pcn_1', field: 'token' }
    const sealed = await v.seal(slot, 'glpat-secret')
    expect(sealed).not.toContain('glpat-secret')
    expect(sealed.startsWith('tv1.k1.')).toBe(true)
    expect(await v.open(slot, sealed)).toBe('glpat-secret')
    await expect(
      v.open({ ...slot, id: 'pcn_2' }, sealed),
    ).rejects.toBeInstanceOf(VaultError)
    await expect(
      v.open({ ...slot, field: 'refresh' }, sealed),
    ).rejects.toBeInstanceOf(VaultError)
  })

  test('a new key seals, the old one still opens, and reseal moves values over', async () => {
    const raw = (b: number) => Buffer.alloc(32, b).toString('base64url')
    const old = (await TokenVault.fromEnv(`k1:${raw(1)}`))!
    const both = (await TokenVault.fromEnv(`k2:${raw(2)},k1:${raw(1)}`))!
    const slot = { kind: 'c', id: '1', field: 'token' }
    const sealedOld = await old.seal(slot, 'x')
    expect(await both.open(slot, sealedOld)).toBe('x')
    const moved = await both.reseal(slot, sealedOld)
    expect(TokenVault.keyOf(moved)).toBe('k2')
    expect(await both.open(slot, moved)).toBe('x')
    const onlyNew = (await TokenVault.fromEnv(`k2:${raw(2)}`))!
    await expect(onlyNew.open(slot, sealedOld)).rejects.toThrow(
      'no longer configured',
    )
  })

  test('refuses malformed key lists', async () => {
    await expect(TokenVault.fromEnv('nope')).rejects.toBeInstanceOf(VaultError)
    await expect(TokenVault.fromEnv('k1:c2hvcnQ')).rejects.toThrow('32 bytes')
    expect(await TokenVault.fromEnv('')).toBeNull()
  })

  test('webhook secrets differ per repository and repeat for the same one', async () => {
    const a = await webhookSecret('master', 'gitlab:1')
    expect(a).toBe(await webhookSecret('master', 'gitlab:1'))
    expect(a).not.toBe(await webhookSecret('master', 'gitlab:2'))
    expect(a).not.toBe(await webhookSecret('other', 'gitlab:1'))
  })
})

describe('shared helpers', () => {
  test('the next page from a Link header', () => {
    expect(
      nextLink(
        '<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"',
      ),
    ).toBe('https://x/a?page=2')
    expect(nextLink('<https://x/a?page=1>; rel="prev"')).toBeNull()
    expect(nextLink(null)).toBeNull()
  })

  test('upstreams: GitLab keeps nested groups in the owner', () => {
    expect(upstreamOf('github', 'a/b')).toEqual({
      provider: 'github',
      owner: 'a',
      name: 'b',
    })
    expect(upstreamOf('gitlab', 'grp/sub/proj')).toEqual({
      provider: 'gitlab',
      owner: 'grp/sub',
      name: 'proj',
    })
  })

  test('language bytes become percentages', () => {
    expect(
      percents([
        ['Lua', 1200],
        ['Shell', 9000],
      ]),
    ).toEqual([
      ['Shell', 88.2],
      ['Lua', 11.8],
    ])
    expect(percents([])).toEqual([])
  })
})

describe('GitHub', () => {
  const repo = (id: number, push = true) => ({
    id,
    full_name: `o/r${id}`,
    private: false,
    default_branch: 'main',
    permissions: { push },
  })

  test('a person lists every page of every installation, with no page limit', async () => {
    const pages = 12
    const routes: Record<string, () => Response> = {
      'GET /user/installations': () =>
        Response.json({ installations: [{ id: 7 }, { id: 8 }] }),
    }
    for (let p = 1; p <= pages; p++)
      routes[`GET /user/installations/7/repositories?per_page=100&page=${p}`] =
        () =>
          Response.json(
            { repositories: [repo(p), repo(1000 + p, false)] },
            {
              headers:
                p < pages
                  ? {
                      link: `<https://api.github.com/user/installations/7/repositories?per_page=100&page=${p + 1}>; rel="next"`,
                    }
                  : {},
            },
          )
    routes['GET /user/installations/7/repositories?per_page=100'] =
      routes['GET /user/installations/7/repositories?per_page=100&page=1']
    routes['GET /user/installations/8/repositories?per_page=100'] = () =>
      Response.json({ repositories: [repo(99)] })
    const { f } = scripted(routes)
    const gh = createGithubForge({ fetch: f })
    const pushable = await gh.pushable('t')
    expect(pushable.size).toBe(pages + 1)
    expect(pushable.get('o/r12')?.installation).toBe(7)
    expect(pushable.get('o/r99')?.installation).toBe(8)
    expect(pushable.has('o/r1001')).toBe(false)
  })

  test('installation tokens are signed with the App key, kept, and renewed near their end', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    let t = 1_800_000_000_000
    let minted = 0
    const { f, calls } = scripted({
      'POST /app/installations/7/access_tokens': () => {
        minted++
        return Response.json({
          token: `ghs_${minted}`,
          expires_at: new Date(t + 60 * 60_000).toISOString(),
        })
      },
      'GET /repos/o/r': () => Response.json(repo(1)),
    })
    const gh = createGithubForge({
      fetch: f,
      now: () => t,
      app: { appId: '42', privateKey: pem, webhookSecret: 's' },
    })
    const auth = { kind: 'installation' as const, installation: 7 }
    await Promise.all([gh.getRepo(auth, 'o/r'), gh.getRepo(auth, 'o/r')])
    expect(minted).toBe(1)
    const jwt = String(
      new Headers(calls[0].init?.headers).get('authorization'),
    ).slice(7)
    const claims = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString(),
    )
    expect(claims.iss).toBe('42')
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    t += 56 * 60_000
    await gh.getRepo(auth, 'o/r')
    expect(minted).toBe(2)
  })

  test('deliveries: the HMAC is checked, and events read the same for every provider', async () => {
    const gh = createGithubForge({ fetch: scripted({}).f })
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: repo(5) })
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`
    const h = new Headers({
      'x-hub-signature-256': sig,
      'x-github-event': 'push',
      'x-github-delivery': 'd-1',
    })
    expect(await gh.verifyWebhook(h, body, 's3cret')).toBe(true)
    expect(await gh.verifyWebhook(h, `${body} `, 's3cret')).toBe(false)
    expect(await gh.verifyWebhook(h, body, 'other')).toBe(false)
    expect(gh.parseWebhook(h, body)).toEqual({
      id: 'd-1',
      event: { kind: 'push', repo: '5', slug: 'o/r5', ref: 'refs/heads/main' },
    })
    const renamed = githubEvent(
      'repository',
      JSON.stringify({
        action: 'renamed',
        repository: { ...repo(5), full_name: 'o/new' },
      }),
    )
    expect(renamed).toMatchObject({
      kind: 'repository',
      action: 'renamed',
      slug: 'o/new',
    })
    expect(
      githubEvent(
        'installation_repositories',
        JSON.stringify({
          action: 'removed',
          installation: { id: 7 },
          repositories_removed: [{ id: 5 }],
        }),
      ),
    ).toEqual({
      kind: 'installation',
      action: 'removed',
      installation: 7,
      added: [],
      removed: ['5'],
    })
    expect(githubEvent('ping', '{}')).toMatchObject({ kind: 'ignored' })
    expect(githubEvent('push', 'not json')).toMatchObject({ kind: 'ignored' })
  })

  test('pull requests, issues without pull requests, conditional requests', async () => {
    const { f, calls } = scripted({
      'GET /repos/o/r/pulls': ({ init }) =>
        new Headers(init?.headers).get('if-none-match') === '"e1"'
          ? new Response(null, { status: 304 })
          : Response.json(
              [
                {
                  number: 3,
                  title: 'x',
                  body: null,
                  state: 'closed',
                  merged_at: '2026-01-02T00:00:00Z',
                  closed_at: '2026-01-02T00:00:00Z',
                  created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-02T00:00:00Z',
                  html_url: 'u',
                  user: { id: 9, login: 'ext' },
                  head: { ref: 'f', sha: 'abc', repo: { full_name: 'fork/r' } },
                  base: { ref: 'main', repo: { full_name: 'o/r' } },
                },
              ],
              { headers: { etag: '"e1"' } },
            ),
      'GET /repos/o/r/issues': () =>
        Response.json([
          {
            number: 1,
            title: 'i',
            body: 'b',
            state: 'open',
            user: null,
            labels: [{ name: 'bug' }],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            closed_at: null,
            html_url: 'u',
          },
          {
            number: 3,
            title: 'pr',
            body: '',
            state: 'closed',
            user: null,
            labels: [],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            closed_at: null,
            html_url: 'u',
            pull_request: {},
          },
        ]),
    })
    const gh = createGithubForge({
      fetch: f,
      installationToken: () => Promise.resolve('ghs'),
    })
    const auth = { kind: 'installation' as const, installation: 1 }
    const first = await gh.listPulls(auth, 'o/r', {})
    expect(first.items[0]).toMatchObject({
      number: 3,
      state: 'merged',
      head: { fromFork: true },
      author: { login: 'ext' },
    })
    expect(first.etag).toBe('"e1"')
    const again = await gh.listPulls(auth, 'o/r', { etag: first.etag })
    expect(again).toMatchObject({ notModified: true, items: [] })
    const issues = await gh.listIssues(auth, 'o/r', {})
    expect(issues.items.map((i) => i.number)).toEqual([1])
    expect(issues.items[0].labels).toEqual(['bug'])
    expect(calls.length).toBe(3)
  })

  test('a provider error says who answered and whether to reconnect', async () => {
    const gh = createGithubForge({
      fetch: scripted({
        'GET /repos/o/r': () =>
          Response.json({ message: 'Bad credentials' }, { status: 401 }),
      }).f,
    })
    const e = await gh.getRepo(user, 'o/r').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).auth).toBe(true)
    expect((e as ProviderError).message).toContain('Bad credentials')
  })
})

describe('GitLab', () => {
  const routes = {
    'POST /oauth/token': ({ init }: { init?: RequestInit }) => {
      const b = new URLSearchParams(init?.body as string)
      if (b.get('refresh_token') === 'spent')
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({
        access_token: 'gla',
        refresh_token: 'glr2',
        expires_in: 7200,
        created_at: 1_800_000_000,
        scope: 'api',
      })
    },
    'GET /api/v4/user': () => Response.json({ id: 77, username: 'mara' }),
    'GET /api/v4/projects/grp%2Fsub%2Fproj': () =>
      Response.json({
        id: 5,
        path_with_namespace: 'grp/sub/proj',
        visibility: 'private',
        default_branch: 'trunk',
        permissions: {
          project_access: null,
          group_access: { access_level: 30 },
        },
        license: { key: 'mit' },
      }),
    'POST /api/v4/projects/grp%2Fsub%2Fproj/hooks': () =>
      Response.json({ id: 900 }),
  }

  test('OAuth with the api scope, refresh, and who is signed in', async () => {
    const { forge, oauth } = createGitlab({
      clientId: 'c',
      clientSecret: 's',
      fetch: scripted(routes).f,
    })
    const url = new URL(oauth.authorizeUrl('st', 'https://cb/gitlab/callback'))
    expect(url.searchParams.get('scope')).toBe('api')
    const t = await oauth.exchange('code', 'https://cb/gitlab/callback')
    expect(t).toEqual({
      access: 'gla',
      refresh: 'glr2',
      expiresAt: 1_800_000_000_000 + 7_200_000,
      scopes: ['api'],
    })
    const e = await oauth.refresh('spent').catch((x: unknown) => x)
    expect((e as ProviderError).auth).toBe(true)
    expect(await oauth.whoami('gla')).toEqual({ id: '77', login: 'mara' })
    expect(forge.capabilities).toMatchObject({
      mode: 'generic',
      lfs: false,
      signature: 'token',
    })
  })

  test('a project in a nested group, Developer can push, the git password is oauth2:<token>', async () => {
    const { forge } = createGitlab({
      clientId: 'c',
      clientSecret: 's',
      fetch: scripted(routes).f,
    })
    const r = await forge.getRepo(user, 'grp/sub/proj')
    expect(r).toMatchObject({
      id: '5',
      defaultBranch: 'trunk',
      private: true,
      canPush: true,
      canAdmin: false,
      license: 'MIT',
    })
    expect(forge.gitCredential(user, 'mara')).toEqual({
      username: 'oauth2',
      password: 'tok',
    })
    expect(
      await forge.createWebhook(user, 'grp/sub/proj', {
        url: 'u',
        secret: 's',
      }),
    ).toEqual({ id: '900' })
  })

  test('deliveries carry the secret in X-Gitlab-Token and a UUID', async () => {
    const { forge } = createGitlab({
      clientId: 'c',
      clientSecret: 's',
      fetch: scripted({}).f,
    })
    const body = JSON.stringify({
      project: { id: 5, path_with_namespace: 'grp/p' },
      ref: 'refs/heads/main',
    })
    const h = new Headers({
      'x-gitlab-token': 'sec',
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-event-uuid': 'u-1',
    })
    expect(await forge.verifyWebhook(h, body, 'sec')).toBe(true)
    expect(await forge.verifyWebhook(h, body, 'other')).toBe(false)
    expect(forge.parseWebhook(h, body)).toEqual({
      id: 'u-1',
      event: { kind: 'push', repo: '5', slug: 'grp/p', ref: 'refs/heads/main' },
    })
    expect(
      gitlabEvent(
        'Merge Request Hook',
        JSON.stringify({
          project: { id: 5, path_with_namespace: 'g/p' },
          object_attributes: { iid: 4, action: 'merge' },
        }),
      ),
    ).toMatchObject({ kind: 'pull_request', number: 4, action: 'merge' })
  })
})

describe('Forgejo and Codeberg', () => {
  test('a repository, the git password, and HMAC deliveries', async () => {
    const { forge, oauth } = createForgejo({
      id: 'codeberg',
      host: 'codeberg.org',
      clientId: 'c',
      clientSecret: 's',
      fetch: scripted({
        'GET /api/v1/repos/ann/zine': () =>
          Response.json({
            id: 31,
            full_name: 'ann/zine',
            private: false,
            default_branch: 'main',
            size: 2,
            permissions: { push: true },
          }),
        'POST /login/oauth/access_token': () =>
          Response.json({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 3600,
          }),
      }).f,
      now: () => 1000,
    })
    expect(await forge.getRepo(user, 'ann/zine')).toMatchObject({
      provider: 'codeberg',
      instance: 'codeberg.org',
      id: '31',
      sizeBytes: 2048,
      canPush: true,
    })
    expect(forge.gitCredential(user, 'ann')).toEqual({
      username: 'ann',
      password: 'tok',
    })
    expect((await oauth.exchange('c', 'r')).expiresAt).toBe(1000 + 3_600_000)
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { id: 31, full_name: 'ann/zine', private: false },
    })
    const h = new Headers({
      'x-forgejo-signature': createHmac('sha256', 'k')
        .update(body)
        .digest('hex'),
      'x-forgejo-event': 'push',
      'x-forgejo-delivery': '0b9c3a3e-1111-4000-8000-000000000000',
    })
    expect(await forge.verifyWebhook(h, body, 'k')).toBe(true)
    expect(await forge.verifyWebhook(h, body, 'x')).toBe(false)
    expect(forge.parseWebhook(h, body).event).toEqual({
      kind: 'push',
      repo: '31',
      slug: 'ann/zine',
      ref: 'refs/heads/main',
    })
    expect(
      forgejoEvent(
        'repository',
        JSON.stringify({
          action: 'deleted',
          repository: { id: 31, full_name: 'ann/zine', private: false },
        }),
      ),
    ).toMatchObject({ kind: 'repository', action: 'deleted' })
  })
})

describe('the fake git stores', () => {
  test('behave like Code Storage on conflicts and credentials', async () => {
    const s = new FakeStores()
    const up = { provider: 'gitlab' as const, owner: 'g', name: 'p' }
    await s.provision('st', { upstream: up, defaultBranch: 'main' })
    await s.provision('st', { upstream: up, defaultBranch: 'main' })
    await expect(
      s.provision('st', {
        upstream: { ...up, name: 'q' },
        defaultBranch: 'main',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'upstream_already_configured',
    })
    const id = await s.setCredential('st', {
      username: 'oauth2',
      password: 'a',
    })
    await expect(
      s.setCredential('st', { username: 'oauth2', password: 'b' }),
    ).rejects.toBeInstanceOf(CredentialExists)
    await s.updateCredential('st', id, { username: 'oauth2', password: 'b' })
    expect(s.stores.get('st')?.credential?.password).toBe('b')
    await s.relink('st', { ...up, name: 'renamed' }, 'main')
    expect(s.stores.get('st')?.upstream?.name).toBe('renamed')
    s.failNext('pull', 409, 'sync_in_progress')
    await expect(s.pull('st')).rejects.toMatchObject({
      code: 'sync_in_progress',
    })
    await s.pull('st')
    expect(s.stores.get('st')?.pulls).toBe(1)
    await s.deleteCredential('st', id)
    expect(s.stores.get('st')?.credential).toBeNull()
  })
})

describe('secrets from a provider', () => {
  test('names become secret variables with no value, never twice', async () => {
    const { declareSecrets, environmentOf } = await import('./secrets')
    expect(environmentOf('Production')).toBe('production')
    expect(environmentOf('staging')).toBe('preview')
    expect(environmentOf('github-pages')).toBeNull()
    const env: Array<EnvVarRec> = [
      {
        name: 'KEEP',
        kind: 'url',
        secret: false,
        set: ['production'],
        description: '',
      },
    ]
    const added = declareSecrets(env, 'github', [
      { name: 'API_KEY', environment: null },
      { name: 'API_KEY', environment: 'production' },
      { name: 'KEEP', environment: null },
      { name: 'not a name', environment: null },
    ])
    expect(added).toBe(1)
    expect(env[1]).toMatchObject({
      name: 'API_KEY',
      secret: true,
      set: [],
      required: ['production'],
    })
    expect(env[0].kind).toBe('url')
    expect(
      declareSecrets(env, 'github', [{ name: 'API_KEY', environment: null }]),
    ).toBe(0)
  })
})

describe('GitHub checks', () => {
  test('check runs and commit statuses become pass, fail or pending', async () => {
    const { f } = scripted({
      'GET /repos/o/r/commits/abc/check-runs': () =>
        Response.json({
          check_runs: [
            {
              id: 1,
              name: 'CI',
              status: 'completed',
              conclusion: 'success',
              html_url: 'u',
              started_at: null,
              completed_at: null,
            },
            {
              id: 2,
              name: 'Lint',
              status: 'completed',
              conclusion: 'failure',
              html_url: null,
              started_at: null,
              completed_at: null,
            },
            {
              id: 3,
              name: 'Docs',
              status: 'completed',
              conclusion: 'skipped',
              html_url: null,
              started_at: null,
              completed_at: null,
            },
            {
              id: 4,
              name: 'Build',
              status: 'in_progress',
              conclusion: null,
              html_url: null,
              started_at: null,
              completed_at: null,
            },
          ],
        }),
      'GET /repos/o/r/commits/abc/status': () =>
        Response.json({
          statuses: [
            {
              id: 9,
              context: 'vercel',
              state: 'error',
              target_url: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
    })
    const gh = createGithubForge({
      fetch: f,
      installationToken: () => Promise.resolve('t'),
    })
    const checks = await gh.checksOf!(
      { kind: 'installation', installation: 1 },
      'o/r',
      'abc',
    )
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ['CI', 'pass'],
      ['Lint', 'fail'],
      ['Docs', 'pass'],
      ['Build', 'pending'],
      ['vercel', 'fail'],
    ])
    expect(
      githubEvent(
        'check_run',
        JSON.stringify({
          action: 'completed',
          repository: {
            id: 5,
            full_name: 'o/r',
            private: false,
            default_branch: 'main',
          },
        }),
      ),
    ).toMatchObject({ kind: 'checks', repo: '5' })
  })
})
