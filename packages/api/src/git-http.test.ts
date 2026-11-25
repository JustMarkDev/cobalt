import { expect, test } from 'bun:test'
import { createGitHttp } from './git-http'
import { apiError } from './problem'
import { sampleTokens } from './sample'
import { harness } from './testing'
import type { GitRemotes } from '@cobaltforge/git/remote'

function setup(beforeGit?: (full: string, write: boolean) => Promise<void>) {
  const h = harness()
  const opened: Array<{ storeId: string; write: boolean; subject: string }> = []
  const remotes: GitRemotes = {
    open: (storeId, o) => {
      opened.push({ storeId, write: o.write, subject: o.subject })
      return Promise.resolve({
        url: `https://git.test/${storeId}.git`,
        authorization: 'Basic upstream',
      })
    },
  }
  const sent: Array<{ url: string; auth: string | null; method: string }> = []
  const gitHttp = createGitHttp({
    verifyToken: h.api.verifyToken,
    domain: h.api.port,
    remotes,
    ...(beforeGit ? { beforeGit } : {}),
    fetch: ((url: string, init?: RequestInit) => {
      sent.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        method: init?.method ?? 'GET',
      })
      return Promise.resolve(
        new Response('refs', { headers: { 'content-type': 'x-git' } }),
      )
    }) as unknown as typeof fetch,
  })
  const basic = (token: string) => `Basic ${btoa(`git:${token}`)}`
  const call = (method: string, path: string, token?: string) =>
    gitHttp(
      new Request(`https://cb.test${path}`, {
        method,
        headers: token ? { authorization: basic(token) } : {},
        body: method === 'POST' ? 'pack' : undefined,
      }),
    )
  return { call, opened, sent }
}

const refs = '/dana/gitfs.git/info/refs?service=git-upload-pack'

test('git asks for the cobalt token, and never passes it on', async () => {
  const g = setup()
  const none = await g.call('GET', refs)
  expect(none.status).toBe(401)
  expect(none.headers.get('www-authenticate')).toContain('Basic')
  const bad = await g.call('GET', refs, 'cbp_nope')
  expect(bad.status).toBe(401)
  expect(g.sent).toHaveLength(0)

  const ok = await g.call('GET', refs, sampleTokens.dana)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('refs')
  expect(g.sent[0]).toMatchObject({
    url: expect.stringContaining('.git/info/refs?service=git-upload-pack'),
    auth: 'Basic upstream',
  })
  expect(g.opened[0]).toMatchObject({ write: false, subject: 'dana' })
})

test('only the four git requests are served', async () => {
  const g = setup()
  expect(
    (await g.call('GET', '/dana/gitfs.git/HEAD', sampleTokens.dana)).status,
  ).toBe(404)
  expect(
    (await g.call('GET', '/dana/dotfiles', sampleTokens.dana)).status,
  ).toBe(404)
  expect(g.sent).toHaveLength(0)
})

test('a repository you cannot see does not exist, and pushing needs write', async () => {
  const g = setup()
  const push = '/dana/gitfs.git/git-receive-pack'
  const own = await g.call('POST', push, sampleTokens.dana)
  expect(own.status).toBe(200)
  expect(g.opened.at(-1)?.write).toBe(true)
  const missing = await g.call(
    'GET',
    '/dana/no-such.git/info/refs?service=git-upload-pack',
    sampleTokens.dana,
  )
  expect(missing.status).toBe(404)
  const others = await g.call(
    'POST',
    '/dana/gitfs.git/git-receive-pack',
    sampleTokens.hollis,
  )
  expect([403, 404]).toContain(others.status)
})

test('a linked repository is checked before git starts: a broken link refuses a push with a reason', async () => {
  const seen: Array<[string, boolean]> = []
  const g = setup((full, write) => {
    seen.push([full, write])
    return write
      ? Promise.reject(
          apiError('invalid_state', 'dana/gitfs is not syncing with GitLab.', {
            hint: 'An admin can take the link over.',
          }),
        )
      : Promise.resolve()
  })
  const read = await g.call('GET', refs, sampleTokens.dana)
  expect(read.status).toBe(200)
  const push = await g.call(
    'GET',
    '/dana/gitfs.git/info/refs?service=git-receive-pack',
    sampleTokens.dana,
  )
  expect(push.status).toBe(403)
  expect(await push.text()).toBe(
    'dana/gitfs is not syncing with GitLab.\nAn admin can take the link over.\n',
  )
  // Checked once per operation, at its first request.
  await g.call('POST', '/dana/gitfs.git/git-upload-pack', sampleTokens.dana)
  expect(seen).toEqual([
    ['dana/gitfs', false],
    ['dana/gitfs', true],
  ])
})
