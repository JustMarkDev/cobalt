import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { harness } from './testing'

type H = ReturnType<typeof harness>

async function signIn(h: H, token?: string) {
  const start = await h.call('POST', '/github/device', { token })
  const polled = await h.call('POST', '/github/device/poll', {
    token,
    body: { device_code: start.json.device_code },
  })
  return polled.json.access as string
}

describe('signing in with GitHub', () => {
  test('a device code, then a proof that lasts and is not the token', async () => {
    const h = harness()
    const start = await h.call('POST', '/github/device')
    expect(start.status).toBe(201)
    expect(start.json.user_code).toBeString()
    const polled = await h.call('POST', '/github/device/poll', {
      body: { device_code: start.json.device_code },
    })
    expect(polled.json).toMatchObject({
      status: 'authorized',
      login: 'dana-okafor',
      expires_in: 600,
    })
    expect(polled.json.access).not.toContain('gho_')
    const repos = await h.call('POST', '/github/repos', {
      body: { access: polled.json.access },
    })
    expect(repos.json.data.map((r: { slug: string }) => r.slug)).toEqual([
      'dana-okafor/dotfiles',
      'dana-okafor/notes',
    ])
    expect(repos.json.data[0].linked).toBeNull()
  })

  test('someone else cannot use your proof', async () => {
    const h = harness()
    const access = await signIn(h)
    const stolen = await h.call('POST', '/github/repos', {
      token: sampleTokens.hollis,
      body: { access },
    })
    expect(stolen.status).toBe(403)
    const imp = await h.call('POST', '/imports', {
      token: sampleTokens.hollis,
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    expect(imp.status).toBe(403)
    expect((await h.call('GET', '/repos/hollis/dotfiles')).status).toBe(404)
  })
})

describe('imports', () => {
  test('a repository linked to GitHub in a two-way sync, once', async () => {
    const h = harness()
    const access = await signIn(h)
    const body = {
      host: 'github',
      slug: 'dana-okafor/dotfiles',
      github_access: access,
    }
    const made = await h.call('POST', '/imports', { body })
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      owner: 'dana',
      name: 'dotfiles',
      upstream: { host: 'github', slug: 'dana-okafor/dotfiles' },
    })
    const mirrors = (await h.call('GET', '/repos/dana/dotfiles/mirrors')).json
      .data
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).toMatchObject({
      host: 'github',
      direction: 'two-way',
      state: 'syncing',
    })
    const again = await h.call('POST', '/imports', { body })
    expect(again.status).toBe(200)
    const mine = (await h.call('GET', '/imports')).json.data
    expect(mine.map((i: { repo: string }) => i.repo)).toContain('dana/dotfiles')
    // The same GitHub repository cannot feed a second repository here.
    const twice = await h.call('POST', '/imports', {
      body: { ...body, name: 'dotfiles-again' },
    })
    expect(twice.status).toBe(409)
    const listed = await h.call('POST', '/github/repos', {
      body: { access },
    })
    expect(listed.json.data[0].linked).toBe('dana/dotfiles')
  })

  test('it needs proof of access, and a repository you cannot push to is refused', async () => {
    const h = harness()
    const none = await h.call('POST', '/imports', {
      body: { host: 'github', slug: 'dana-okafor/dotfiles' },
    })
    expect(none.status).toBe(400)
    const access = await signIn(h)
    const foreign = await h.call('POST', '/imports', {
      body: {
        host: 'github',
        slug: 'someone-else/private-thing',
        github_access: access,
      },
    })
    expect(foreign.status).toBe(403)
    expect((await h.call('GET', '/repos/dana/private-thing')).status).toBe(404)
  })

  test('only GitHub is linked', async () => {
    const h = harness()
    const gitlab = await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'x/zine' },
    })
    expect(gitlab.status).toBe(400)
  })

  test('a dry run makes nothing', async () => {
    const h = harness()
    const access = await signIn(h)
    await h.call('POST', '/imports?dry_run=true', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    expect((await h.call('GET', '/repos/dana/dotfiles')).status).toBe(404)
  })
})

describe('linked accounts', () => {
  test('recorded as given, unverified, one per host', async () => {
    const h = harness()
    const list = (await h.call('GET', '/accounts/dana/links')).json.data
    expect(list[0]).toMatchObject({
      host: 'github',
      login: 'dana-okafor',
      verified: false,
    })
    await h.call('PUT', '/accounts/dana/links/github', {
      body: { login: 'dana-o' },
    })
    const after = (await h.call('GET', '/accounts/dana/links')).json.data
    expect(after).toHaveLength(1)
    expect(after[0].login).toBe('dana-o')
    const gitea = await h.call('PUT', '/accounts/dana/links/gitea', {
      body: { login: 'dana' },
    })
    expect(gitea.status).toBe(400)
    expect((await h.call('DELETE', '/accounts/dana/links/github')).status).toBe(
      204,
    )
  })

  test('only your own', async () => {
    const h = harness()
    expect(
      (
        await h.call('GET', '/accounts/dana/links', {
          token: sampleTokens.hollis,
        })
      ).status,
    ).toBe(404)
  })
})
