import { expect, test } from 'bun:test'
import { createGithub, openAccess, sealAccess } from './github'

const cfg = {
  clientId: 'Iv1.abc',
  sealKey: 'a-long-enough-server-secret',
  slug: 'cobalt-forge-sync',
}

type Call = { url: string; body: string; auth: string | null }

function fakeGithub(over: Record<string, (() => Response) | undefined> = {}) {
  const calls: Array<Call> = []
  const fetch = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.get('authorization'),
    })
    const path = url.replace('https://api.github.com', '')
    const hit = over[url] ?? over[path]
    if (hit) return Promise.resolve(hit())
    const json = (v: unknown) => Promise.resolve(Response.json(v))
    if (url === 'https://github.com/login/device/code')
      return json({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })
    if (url === 'https://github.com/login/oauth/access_token')
      return json({ access_token: 'gho_user' })
    if (path === '/user') return json({ login: 'dana' })
    if (path.startsWith('/user/installations?'))
      return json({ installations: [{ id: 7 }] })
    if (path.startsWith('/user/installations/7/repositories'))
      return json({
        repositories: [
          {
            id: 1,
            full_name: 'dana/music',
            private: true,
            default_branch: 'main',
            permissions: { push: true },
          },
          {
            id: 2,
            full_name: 'someone/readonly',
            private: false,
            default_branch: 'main',
            permissions: { pull: true },
          },
        ],
      })
    return Promise.resolve(new Response('nope', { status: 404 }))
  }
  return { calls, fetch }
}

test('the device flow ends in a sealed access that is bound to the person', async () => {
  const { fetch } = fakeGithub()
  const gh = createGithub(cfg, { fetch, now: () => 1000 })
  const start = await gh.deviceStart()
  expect(start.userCode).toBe('ABCD-1234')
  const done = await gh.devicePoll('dc', 'dana')
  if (done.status !== 'authorized') throw new Error('not authorized')
  expect(done.login).toBe('dana')
  // The token never leaves the sealed blob, and the blob is not readable.
  expect(done.access).not.toContain('gho_user')
  const opened = await openAccess(cfg.sealKey, done.access, 'dana', 1000)
  expect(opened.token).toBe('gho_user')
  // Someone else cannot use it, nor can it be used after ten minutes.
  await expect(
    openAccess(cfg.sealKey, done.access, 'mallory', 1000),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await expect(
    openAccess(cfg.sealKey, done.access, 'dana', 1000 + 11 * 60_000),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await expect(
    openAccess('another-secret-entirely', done.access, 'dana', 1000),
  ).rejects.toMatchObject({ code: 'forbidden' })
})

test('polling reports what GitHub reports', async () => {
  for (const [error, status] of [
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const) {
    const { fetch } = fakeGithub({
      'https://github.com/login/oauth/access_token': () =>
        Response.json({ error }),
    })
    const r = await createGithub(cfg, { fetch }).devicePoll('dc', 'dana')
    expect(r.status).toBe(status)
  }
})

test('only the repositories the person may push to are offered', async () => {
  const { fetch } = fakeGithub()
  const gh = createGithub(cfg, { fetch, now: () => 5 })
  const done = await gh.devicePoll('dc', 'dana')
  if (done.status !== 'authorized') throw new Error('not authorized')
  expect((await gh.repos(done.access, 'dana')).map((r) => r.slug)).toEqual([
    'dana/music',
  ])
  expect((await gh.authorize(done.access, 'dana', 'DANA/music')).id).toBe(1)
  await expect(
    gh.authorize(done.access, 'dana', 'someone/readonly'),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await expect(
    gh.authorize(done.access, 'dana', 'victim/private'),
  ).rejects.toMatchObject({ code: 'forbidden' })
})

test('a sealed blob that was altered is refused', async () => {
  const access = await sealAccess(
    cfg.sealKey,
    { token: 't', handle: 'dana', login: 'dana' },
    0,
  )
  const forged = `${access.slice(0, -3)}AAA`
  await expect(
    openAccess(cfg.sealKey, forged, 'dana', 0),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await expect(
    openAccess(cfg.sealKey, 'gho_raw', 'dana', 0),
  ).rejects.toMatchObject({ code: 'forbidden' })
})
