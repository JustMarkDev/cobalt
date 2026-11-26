import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { sampleTokens } from '../sample'
import { clock, harness, onConvex } from '../testing'
import { sampleGitlab, sampleGitlabFetch } from './sample'
import { webhookSecret } from './vault'
import type { FakeStores } from '@cobaltforge/git/fake'
import type { ProviderSync } from './sync'

type H = ReturnType<typeof harness>

const sync = (h: H) => h.api.domain.svc.providers as ProviderSync
const stores = (h: H) => sync(h).deps.git as FakeStores

async function githubAccess(h: H) {
  const start = await h.call('POST', '/github/device')
  return (
    await h.call('POST', '/github/device/poll', {
      body: { device_code: start.json.device_code },
    })
  ).json.access as string
}

async function connectGitlab(h: H, token?: string) {
  const redirect_uri = 'https://cobaltforge.dev/gitlab/callback'
  const start = await h.call('POST', '/providers/gitlab/oauth', {
    token,
    body: { redirect_uri },
  })
  expect(start.status).toBe(201)
  return h.call('POST', '/providers/gitlab/oauth/finish', {
    token,
    body: {
      code: 'c0de',
      state: new URL(start.json.url).searchParams.get('state'),
      redirect_uri,
    },
  })
}

const ghHook = (
  h: H,
  event: string,
  id: string,
  body: unknown,
  secret = 'sample-github-hook-secret',
) => {
  const text = JSON.stringify(body)
  return h.api.receiveHook(
    'github',
    new Request('https://cobaltforge.dev/hooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': event,
        'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`,
      },
      body: text,
    }),
  )
}

const dotfiles = { id: 101, full_name: 'dana-okafor/dotfiles', private: false }

describe.skipIf(onConvex)('GitHub through the App', () => {
  test('an import provisions a store linked to GitHub, with metadata and warnings', async () => {
    const h = harness()
    const access = await githubAccess(h)
    const made = await h.call('POST', '/imports', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      description: 'My shell, editor and git setup.',
      language: 'Shell',
    })
    expect(stores(h).stores.get('dana/dotfiles')).toMatchObject({
      upstream: { provider: 'github', owner: 'dana-okafor', name: 'dotfiles' },
      defaultBranch: 'main',
    })
    const link = (await h.call('GET', '/repos/dana/dotfiles/provider')).json
    expect(link).toMatchObject({
      provider: 'github',
      state: 'syncing',
      connection: null,
      adoptable: false,
      url: 'https://github.com/dana-okafor/dotfiles',
    })
    expect(link.warnings[0]).toContain(
      "GitHub's branch protection rules still apply",
    )
    const imports = (await h.call('GET', '/imports')).json.data
    expect(imports[0].warnings[0]).toContain('Access is decided here')
  })

  test('webhooks: the signature is checked, a push pulls, a redelivery does nothing', async () => {
    const h = harness()
    const access = await githubAccess(h)
    await h.call('POST', '/imports', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    const forged = await ghHook(
      h,
      'push',
      'd1',
      { repository: dotfiles },
      'wrong',
    )
    expect(forged.status).toBe(401)
    const push = await ghHook(h, 'push', 'd1', {
      ref: 'refs/heads/main',
      repository: dotfiles,
    })
    expect([push.status, await push.text()]).toEqual([200, 'pulled'])
    expect(stores(h).stores.get('dana/dotfiles')?.pulls).toBe(1)
    const again = await ghHook(h, 'push', 'd1', {
      ref: 'refs/heads/main',
      repository: dotfiles,
    })
    expect(await again.text()).toBe('duplicate')
    expect(stores(h).stores.get('dana/dotfiles')?.pulls).toBe(1)
    const elsewhere = await ghHook(h, 'push', 'd2', {
      repository: { ...dotfiles, id: 999 },
    })
    expect(await elsewhere.text()).toBe('not linked here')
    expect(
      (await h.call('GET', '/repos/dana/dotfiles/provider')).json.state,
    ).toBe('linked')
  })

  test('a rename relinks the store to the new name; removing the App breaks the link', async () => {
    const h = harness()
    const access = await githubAccess(h)
    await h.call('POST', '/imports', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    const renamed = await ghHook(h, 'repository', 'r1', {
      action: 'renamed',
      repository: { ...dotfiles, full_name: 'dana-okafor/dots' },
    })
    expect(await renamed.text()).toBe('relinked')
    expect(stores(h).stores.get('dana/dotfiles')?.upstream).toEqual({
      provider: 'github',
      owner: 'dana-okafor',
      name: 'dots',
    })
    expect(
      (await h.call('GET', '/repos/dana/dotfiles/provider')).json.slug,
    ).toBe('dana-okafor/dots')
    const audit = (await h.call('GET', '/providers/audit')).json.data
    expect(audit.map((a: { action: string }) => a.action)).toContain('relinked')

    await ghHook(h, 'installation_repositories', 'i1', {
      action: 'removed',
      installation: { id: 1 },
      repositories_removed: [{ id: 101 }],
    })
    const broken = (await h.call('GET', '/repos/dana/dotfiles/provider')).json
    expect(broken).toMatchObject({ state: 'broken' })
    const mirror = (await h.call('GET', '/repos/dana/dotfiles/mirrors')).json
      .data[0]
    expect(mirror.state).toBe('failing')
    await ghHook(h, 'installation_repositories', 'i2', {
      action: 'added',
      installation: { id: 1 },
      repositories_added: [{ id: 101 }],
    })
    expect(
      (await h.call('GET', '/repos/dana/dotfiles/provider')).json.state,
    ).toBe('linked')
  })

  test('a bulk import checks access once, runs in the background, and retries a busy store', async () => {
    const h = harness()
    const access = await githubAccess(h)
    const refused = await h.call('POST', '/imports/batch', {
      body: {
        provider: 'github',
        slugs: ['dana-okafor/dotfiles', 'someone/else'],
        github_access: access,
      },
    })
    expect([refused.status, refused.json.code]).toEqual([403, 'forbidden'])
    const job = await h.call('POST', '/imports/batch', {
      body: {
        provider: 'github',
        slugs: ['dana-okafor/dotfiles', 'dana-okafor/notes'],
        github_access: access,
      },
    })
    expect(job.status).toBe(202)
    expect(job.json).toMatchObject({ state: 'running', total: 2, done: 0 })
    stores(h).failNext('provision', 409, 'sync_in_progress')
    await sync(h).tick({ concurrency: 1 })
    const mid = (await h.call('GET', `/imports/jobs/${job.json.id}`)).json
    expect(mid.items[0]).toMatchObject({ state: 'queued', attempts: 1 })
    expect(mid.items[0].error).toContain('sync_in_progress')
    ;(h.now as ReturnType<typeof clock>).advance(10_000)
    await sync(h).tick()
    const done = (await h.call('GET', `/imports/jobs/${job.json.id}`)).json
    expect(done).toMatchObject({ state: 'done', done: 1, failed: 1 })
    expect(done.items).toMatchObject([
      {
        slug: 'dana-okafor/dotfiles',
        state: 'done',
        repo: 'dana/dotfiles',
        attempts: 2,
      },
      {
        slug: 'dana-okafor/notes',
        state: 'failed',
        error: 'dana/notes already exists and is not linked to GitHub.',
      },
    ])
    const other = await h.call('GET', `/imports/jobs/${job.json.id}`, {
      token: sampleTokens.hollis,
    })
    expect(other.status).toBe(404)
  })
})

describe.skipIf(onConvex)('GitLab in generic mode', () => {
  test('connect, import: a credential for Code Storage, a webhook, items read-only', async () => {
    const h = harness()
    const none = await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    expect(none.json.code).toBe('invalid_state')
    const c = await connectGitlab(h)
    expect(c.status).toBe(200)
    expect(c.json.connection).toMatchObject({
      provider: 'gitlab',
      login: 'dana.okafor',
      state: 'ok',
      scopes: ['api'],
    })
    expect(JSON.stringify(c.json)).not.toContain('glsample')
    const listed = await h.call('POST', '/providers/gitlab/repos', {
      body: { q: 'zine' },
    })
    expect(listed.json.data[0]).toMatchObject({
      slug: 'dana.okafor/zine',
      can_push: true,
      linked: null,
    })

    const made = await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    expect(made.status).toBe(201)
    expect(made.json.upstream).toEqual({
      host: 'gitlab',
      slug: 'dana.okafor/zine',
    })
    const st = stores(h).stores.get('dana/zine')!
    expect(st.upstream).toEqual({
      provider: 'gitlab',
      owner: 'dana.okafor',
      name: 'zine',
    })
    expect(st.credential).toMatchObject({ username: 'oauth2' })
    expect(st.credential?.password.startsWith('glsample-')).toBe(true)
    const link = (await h.call('GET', '/repos/dana/zine/provider')).json
    expect(link).toMatchObject({
      state: 'syncing',
      connection: { handle: 'dana', login: 'dana.okafor', state: 'ok' },
    })

    await sync(h).tick()
    const pulls = (await h.call('GET', '/repos/dana/zine/provider/pulls')).json
      .data
    expect(
      pulls.map((p: { number: number; state: string }) => [p.number, p.state]),
    ).toEqual([
      [3, 'open'],
      [2, 'landed'],
    ])
    expect(pulls[0]).toMatchObject({
      from_fork: true,
      commits_here: false,
      has_patch: true,
      author: { login: 'tomas.r' },
    })
    const patch = (
      await h.call('GET', '/repos/dana/zine/provider/pulls/3/patch')
    ).json
    expect(patch.text).toContain(
      'diff --git a/styles/print.css b/styles/print.css',
    )
    const issue = (await h.call('GET', '/repos/dana/zine/provider/issues/5'))
      .json
    expect(issue).toMatchObject({
      state: 'open',
      labels: ['bug', 'print'],
      comments: 1,
    })
    const rel = (await h.call('GET', '/repos/dana/zine/provider/releases')).json
      .data
    expect(rel[0]).toMatchObject({ tag: 'v0.3.0', name: 'Zine 0.3' })
    expect(
      (
        await h.call('POST', '/repos/dana/zine/provider/issues/5/comments', {
          body: { body: 'x' },
        })
      ).status,
    ).toBe(405)
  })

  test('a first sync still running is looked at again, and items are read again on a schedule', async () => {
    const now = clock()
    const h = harness({ now })
    await connectGitlab(h)
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    const items = sync(h).items as unknown as {
      hasCommit: (full: string, sha: string) => Promise<boolean>
    }
    // The store has no default branch yet: the git sync is still running.
    items.hasCommit = () => Promise.resolve(false)
    await sync(h).tick()
    const store = sync(h).store
    const linkOf = () => store.remoteOfRepo('dana/zine')
    expect((await linkOf())!.state).toBe('syncing')
    expect(await store.itemsDue(now() + 59_000, 5)).toHaveLength(0)
    expect(await store.itemsDue(now() + 61_000, 5)).toHaveLength(1)
    // It settles: the next look says so, without a push to wake it.
    items.hasCommit = () => Promise.resolve(true)
    now.advance(61_000)
    await sync(h).tick()
    expect((await linkOf())!.state).toBe('linked')
    expect(
      (await h.call('GET', '/repos/dana/zine/mirrors')).json.data[0].state,
    ).toBe('in-sync')
    // A missed webhook costs at most half an hour.
    expect(await store.itemsDue(now() + 29 * 60_000, 5)).toHaveLength(0)
    expect(await store.itemsDue(now() + 31 * 60_000, 5)).toHaveLength(1)
  })

  test('a GitLab delivery carries the per-repository secret; a push pulls', async () => {
    const h = harness()
    await connectGitlab(h)
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    const body = JSON.stringify({
      project: { id: 61_204_118, path_with_namespace: 'dana.okafor/zine' },
      ref: 'refs/heads/main',
    })
    const send = async (token: string, id: string) =>
      h.api.receiveHook(
        'gitlab',
        new Request('https://cobaltforge.dev/hooks/gitlab', {
          method: 'POST',
          headers: {
            'x-gitlab-token': token,
            'x-gitlab-event': 'Push Hook',
            'x-gitlab-event-uuid': id,
          },
          body,
        }),
      )
    expect((await send('guess', 'u1')).status).toBe(401)
    const secret = await webhookSecret(
      'sample-provider-hook-secret',
      'gitlab:61204118',
    )
    const ok = await send(secret, 'u1')
    expect([ok.status, await ok.text()]).toEqual([200, 'pulled'])
    expect(stores(h).stores.get('dana/zine')?.pulls).toBe(1)
    expect((await h.call('GET', '/repos/dana/zine/provider')).json.state).toBe(
      'linked',
    )
  })

  test('an expiring token is refreshed once for concurrent git requests and written to Code Storage', async () => {
    const now = clock()
    let refreshes = 0
    const base = sampleGitlabFetch(now)
    const gl = sampleGitlab(now)
    void gl
    const h = harness({ now })
    const s = sync(h)
    const { createGitlab } = await import('./gitlab')
    const counted = createGitlab({
      clientId: 'c',
      clientSecret: 's',
      now,
      fetch: async (url, init) => {
        if (
          url.endsWith('/oauth/token') &&
          ((init?.body as string | undefined) ?? '').includes('refresh_token')
        ) {
          refreshes++
          await new Promise((r) => setTimeout(r, 20))
        }
        return base(url, init)
      },
    })
    s.deps.forges.gitlab = counted.forge
    s.deps.oauth.gitlab = counted.oauth
    await connectGitlab(h)
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    const first = stores(h).stores.get('dana/zine')!.credential!.password
    now.advance(7_200_000 - 60_000)
    await Promise.all([
      s.beforeGit('dana/zine', true),
      s.beforeGit('dana/zine', true),
      s.beforeGit('dana/zine', false),
    ])
    expect(refreshes).toBe(1)
    const second = stores(h).stores.get('dana/zine')!.credential!.password
    expect(second).not.toBe(first)
  })

  test('a refused refresh marks the connection; a push is refused with who can fix it; reconnecting heals', async () => {
    const now = clock()
    const h = harness({ now })
    const s = sync(h)
    const base = sampleGitlabFetch(now)
    let refuse = true
    const { createGitlab } = await import('./gitlab')
    const g = createGitlab({
      clientId: 'c',
      clientSecret: 's',
      now,
      fetch: (url, init) =>
        refuse &&
        url.endsWith('/oauth/token') &&
        ((init?.body as string | undefined) ?? '').includes('refresh_token')
          ? Promise.resolve(
              Response.json({ error: 'invalid_grant' }, { status: 400 }),
            )
          : base(url, init),
    })
    s.deps.forges.gitlab = g.forge
    s.deps.oauth.gitlab = g.oauth
    await connectGitlab(h)
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    now.advance(7_200_000)
    const e = await s
      .beforeGit('dana/zine', true)
      .catch((x: unknown) => x as { code: string; hint?: string })
    expect(e).toMatchObject({ code: 'invalid_state' })
    expect((e as { hint?: string }).hint).toContain('connect GitLab again')
    const conn = (await h.call('GET', '/providers')).json.data[0]
    expect(conn).toMatchObject({ state: 'needs_reconnect' })
    expect((await h.call('GET', '/repos/dana/zine/provider')).json.state).toBe(
      'broken',
    )
    refuse = false
    await connectGitlab(h)
    expect((await h.call('GET', '/repos/dana/zine/provider')).json.state).toBe(
      'linked',
    )
    const actions = (await h.call('GET', '/providers/audit')).json.data.map(
      (a: { action: string }) => a.action,
    )
    expect(actions).toEqual(
      expect.arrayContaining([
        'connected',
        'imported',
        'needs_reconnect',
        'reconnected',
      ]),
    )
  })

  test('an admin adopts a link whose connection is gone; disconnecting undoes everything', async () => {
    const h = harness()
    await connectGitlab(h)
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine', owner: 'northwind' },
    })
    const s = sync(h)
    const r = (await s.store.remoteOfRepo('northwind/zine'))!
    await s.store.patchRemote(r.id, {
      connectionId: null,
      webhookId: null,
      state: 'broken',
      problem: 'gone',
    })
    expect(
      (await h.call('GET', '/repos/northwind/zine/provider')).json.adoptable,
    ).toBe(true)
    const member = await h.call(
      'POST',
      '/repos/northwind/zine/provider/adopt',
      { token: sampleTokens.hollis },
    )
    expect([403, 404]).toContain(member.status)
    const adopted = await h.call('POST', '/repos/northwind/zine/provider/adopt')
    expect(adopted.status).toBe(200)
    expect(adopted.json).toMatchObject({
      state: 'linked',
      connection: { handle: 'dana' },
      problem: null,
    })

    const off = await h.call('DELETE', '/providers/gitlab')
    expect(off.status).toBe(204)
    expect(
      (await h.call('GET', '/repos/northwind/zine')).json.upstream,
    ).toBeNull()
    expect(stores(h).stores.get('northwind/zine')).toMatchObject({
      upstream: null,
      credential: null,
    })
    expect((await h.call('GET', '/providers')).json.data).toEqual([])
  })
})
