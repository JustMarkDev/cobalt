import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { sdkSource } from '../../../scripts/api-sdk'
import { CbError, createClient, signInWithGitHub } from '@cobaltforge/sdk'
import { sampleTokens } from './sample'
import { harness } from './testing'

function clientFor(
  overrides: Parameters<typeof harness>[0] = {},
  token: string = sampleTokens.dana,
) {
  const h = harness(overrides)
  const seen: Array<{
    url: string
    method: string
    status: number
    headers: Headers
  }> = []
  const cb = createClient({
    baseUrl: 'https://api.test/v1',
    token,
    retries: 3,
    fetch: (async (url: string, init?: RequestInit) => {
      const res = await h.api.fetch(new Request(url, init))
      seen.push({
        url,
        method: init?.method ?? 'GET',
        status: res.status,
        headers: new Headers(init?.headers),
      })
      return res
    }) as unknown as typeof fetch,
  })
  return { cb, h, seen }
}

describe('the TypeScript client', () => {
  test('the committed client is what the generator writes (run: bun scripts/api-sdk.ts)', async () => {
    expect(
      readFileSync(new URL('../../sdk/index.ts', import.meta.url), 'utf8'),
    ).toBe(await sdkSource())
  })

  test('signing in with GitHub gives the proof that imports take', async () => {
    const { cb } = clientFor()
    const shown: Array<string> = []
    const { access, login } = await signInWithGitHub(cb, {
      onCode: (c) => {
        shown.push(`${c.verification_uri} ${c.user_code}`)
      },
    })
    expect(shown).toEqual(['https://github.com/login/device WDJB-MJHT'])
    expect(login).toBe('dana-okafor')
    const repo = await cb.imports.create({
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    expect(repo.upstream).toMatchObject({ slug: 'dana-okafor/dotfiles' })
  })

  test('reads, writes and nested groups work, with the types the server publishes', async () => {
    const { cb } = clientFor()
    const change = await cb.changes.get({
      owner: 'dana',
      repo: 'gitfs',
      number: '216',
    })
    expect(change.object).toBe('change')
    expect(change.number).toBe(216)
    const made = await cb.issues.create({
      owner: 'dana',
      repo: 'gitfs',
      body: { title: 'From the SDK' },
    })
    expect(made.title).toBe('From the SDK')
    const principal = await cb.auth.principal()
    expect(principal.login).toBe('dana')
    const again = await cb.call('issues.get', {
      owner: 'dana',
      repo: 'gitfs',
      number: made.number,
    })
    expect(again.id).toBe(made.id)
  })

  test('a secret-bearing write is not given an automatic idempotency key', async () => {
    const { cb, seen } = clientFor()
    await cb.tokens.create({
      body: { name: 'sdk-token', scopes: ['repo:read'] },
    })
    const call = seen.find(
      (s) => s.method === 'POST' && s.url.endsWith('/tokens'),
    )
    expect(call?.headers.get('idempotency-key')).toBeNull()
  })

  test('uploads.put sends the declared content type', async () => {
    const { cb, seen } = clientFor()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const made = await cb.uploads.create({
      body: {
        filename: 'sdk.png',
        content_type: 'image/png',
        size: png.length,
      },
    })
    const url = new URL(made.upload_url!)
    const done = await cb.uploads.put({
      id: made.id,
      exp: Number(url.searchParams.get('exp')),
      sig: url.searchParams.get('sig')!,
      body: png,
      contentType: 'image/png',
    })
    expect(done.state).toBe('uploaded')
    const sent = seen.find((s) => s.method === 'PUT')
    expect(sent?.headers.get('content-type')).toBe('image/png')
  })

  test('a repeat read is a 304 that costs nothing, and the caller still gets the object', async () => {
    const { cb, seen } = clientFor()
    const a = await cb.changes.get({
      owner: 'dana',
      repo: 'gitfs',
      number: '216',
    })
    const b = await cb.changes.get({
      owner: 'dana',
      repo: 'gitfs',
      number: '216',
    })
    expect(b).toEqual(a)
    expect(seen.map((s) => s.status)).toEqual([200, 304])
    expect(cb.last?.get('etag')).toBeTruthy()
  })

  test('pagination walks every page', async () => {
    const { cb, h } = clientFor()
    for (let i = 0; i < 5; i++)
      await h.call('POST', '/repos/dana/gitfs/issues', {
        body: { title: `Page me ${i}` },
      })
    const all: Array<string> = []
    for await (const issue of cb.paginate('issues.list', {
      owner: 'dana',
      repo: 'gitfs',
      state: 'all',
      limit: 2,
    }))
      all.push(issue.title)
    const direct = (
      await cb.issues.list({
        owner: 'dana',
        repo: 'gitfs',
        state: 'all',
        limit: 200,
      })
    ).data.map((i) => i.title)
    expect(all).toEqual(direct)
    expect(all.length).toBeGreaterThanOrEqual(5)
  })

  test('an error carries everything the catalog says about it', async () => {
    const { cb } = clientFor()
    const err = await cb.changes
      .get({ owner: 'dana', repo: 'gitfs', number: '99999' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CbError)
    const e = err as CbError
    expect(e).toMatchObject({
      status: 404,
      code: 'not_found',
      retryable: false,
    })
    expect(e.requestId).toMatch(/^req_/)
    expect(e.exitCode).toBeGreaterThan(0)
    expect(typeof e.hint).toBe('string')
    await expect(
      cb.changes.get({ owner: 'dana', repo: 'gitfs' } as never),
    ).rejects.toThrow('needs number')
  })

  test('a flaky network is retried, and a write is retried with the same key so it happens once', async () => {
    const h = harness()
    let calls = 0
    const keys: Array<string | null> = []
    const cb = createClient({
      baseUrl: 'https://api.test/v1',
      token: sampleTokens.dana,
      fetch: (async (url: string, init?: RequestInit) => {
        calls++
        keys.push(new Headers(init?.headers).get('idempotency-key'))
        if (calls <= 2)
          return new Response(
            JSON.stringify({
              code: 'backend_unavailable',
              retryable: true,
              detail: 'try again',
            }),
            { status: 503, headers: { 'retry-after': '0' } },
          )
        return h.api.fetch(new Request(url, init))
      }) as unknown as typeof fetch,
    })
    const made = await cb.repos.create(
      { body: { name: 'retried-once' } },
      { idempotencyKey: 'retry-key' },
    )
    expect(made.name).toBe('retried-once')
    expect(calls).toBe(3)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('retry-key')
    expect((await h.call('GET', '/repos/dana/retried-once')).status).toBe(200)
  })

  test('what cannot help is not retried, and the budget is respected', async () => {
    let calls = 0
    const cb = createClient({
      baseUrl: 'https://api.test/v1',
      retries: 2,
      fetch: (() => {
        calls++
        return Promise.resolve(
          new Response(
            JSON.stringify({ code: 'invalid_request', retryable: false }),
            { status: 400 },
          ),
        )
      }) as unknown as typeof fetch,
    })
    await expect(cb.api.root()).rejects.toBeInstanceOf(CbError)
    expect(calls).toBe(1)
    calls = 0
    const down = createClient({
      baseUrl: 'https://api.test/v1',
      retries: 2,
      fetch: (() => {
        calls++
        return Promise.resolve(
          new Response('{}', { status: 503, headers: { 'retry-after': '0' } }),
        )
      }) as unknown as typeof fetch,
    })
    await expect(down.api.root()).rejects.toBeInstanceOf(CbError)
    expect(calls).toBe(3)
  })

  test('request options reach the server: dry run, If-Match and a key of your own', async () => {
    const { cb, seen } = clientFor()
    const dry = await cb.issues.create(
      { owner: 'dana', repo: 'gitfs', body: { title: 'Not saved' } },
      { dryRun: true },
    )
    expect(dry.title).toBe('Not saved')
    expect(seen.at(-1)!.url).toContain('dry_run=true')
    const list = await cb.issues.list({
      owner: 'dana',
      repo: 'gitfs',
      state: 'all',
    })
    expect(list.data.some((i) => i.title === 'Not saved')).toBe(false)
    await expect(
      cb.issues.update(
        {
          owner: 'dana',
          repo: 'gitfs',
          number: list.data[0].number,
          body: { title: 'x' },
        },
        { ifMatch: '"0"' },
      ),
    ).rejects.toMatchObject({ status: 412, code: 'version_mismatch' })
    await cb.issues.create(
      { owner: 'dana', repo: 'gitfs', body: { title: 'Keyed' } },
      { idempotencyKey: 'mine-1' },
    )
    expect(seen.at(-1)!.headers.get('idempotency-key')).toBe('mine-1')
  })
})
