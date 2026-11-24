import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  accepts,
  carriesSecrets,
  compressDynamic,
  serveBuilt,
} from './compress'

const req = (encoding?: string, method = 'GET') =>
  new Request('http://x/', {
    method,
    headers: encoding === undefined ? {} : { 'accept-encoding': encoding },
  })
const big = JSON.stringify({ data: 'x'.repeat(4000) })

describe('accepts', () => {
  test('reads names, q-values and the wildcard', () => {
    expect(accepts('gzip, deflate, br', 'br')).toBe(true)
    expect(accepts('gzip', 'br')).toBe(false)
    expect(accepts('br;q=0, gzip', 'br')).toBe(false)
    expect(accepts('*', 'gzip')).toBe(true)
    expect(accepts('gzip;q=0, *', 'gzip')).toBe(false)
    expect(accepts(null, 'gzip')).toBe(false)
  })
})

describe('carriesSecrets', () => {
  test('sign-in answers and OAuth pages go uncompressed; pages and the API do not', () => {
    for (const p of [
      '/api/auth/get-session',
      '/api/auth/convex/token',
      '/api/v1/oauth/device',
      '/api/v1/oauth/authorize',
    ])
      expect([p, carriesSecrets(p)]).toEqual([p, true])
    for (const p of [
      '/',
      '/dana/gitfs/code',
      '/api/v1/repos',
      '/api/v1/oauthish',
      '/docs',
    ])
      expect([p, carriesSecrets(p)]).toEqual([p, false])
  })
})

describe('compressDynamic', () => {
  const json = (
    body = big,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) =>
    new Response(body, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    })

  test('gzips JSON for a client that takes it', async () => {
    const res = await compressDynamic(req('gzip, br'), json())
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    const body = gunzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(new TextDecoder().decode(body)).toBe(big)
  })

  test('keeps the status and adds to an existing Vary', async () => {
    const res = await compressDynamic(
      req('gzip'),
      json(big, { status: 201, headers: { vary: 'authorization' } }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('vary')).toBe('authorization, Accept-Encoding')
  })

  test('leaves alone what must not or need not be compressed', async () => {
    const cases: Array<[Request, Response]> = [
      [req(), json()],
      [req('gzip', 'HEAD'), json()],
      [req('gzip'), json('{}', { headers: { 'content-length': '2' } })],
      [req('gzip'), new Response(null, { status: 304 })],
      [
        req('gzip'),
        new Response(big, { headers: { 'content-type': 'text/event-stream' } }),
      ],
      [
        req('gzip'),
        new Response(big, { headers: { 'content-type': 'image/png' } }),
      ],
      [
        req('gzip'),
        json(big, { headers: { 'cache-control': 'no-transform' } }),
      ],
      [req('gzip'), json(big, { headers: { 'content-encoding': 'br' } })],
    ]
    for (const [request, response] of cases)
      expect(
        (await compressDynamic(request, response)).headers.get(
          'content-encoding',
        ),
      ).toBe(response.headers.get('content-encoding'))
  })

  test('a small body without a stated length goes as it is', async () => {
    const small = new Response(new Blob(['{"ok":true}']).stream(), {
      headers: { 'content-type': 'application/json' },
    })
    expect(small.headers.get('content-length')).toBeNull()
    const res = await compressDynamic(req('gzip'), small)
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBe('11')
    expect(await res.text()).toBe('{"ok":true}')
  })

  test('a long stream is compressed whole, the part read first included', async () => {
    const parts = [
      '<p>',
      'x'.repeat(100),
      'y'.repeat(200),
      'z'.repeat(5000),
      '</p>',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p))
        c.close()
      },
    })
    const res = await compressDynamic(
      req('gzip'),
      new Response(stream, { headers: { 'content-type': 'text/html' } }),
    )
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const body = gunzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(new TextDecoder().decode(body)).toBe(parts.join(''))
  })
})

describe('serveBuilt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'built-'))
  const path = join(dir, 'app.js')
  writeFileSync(path, big)
  writeFileSync(`${path}.gz`, gzipSync(big))
  writeFileSync(`${path}.br`, 'brotli bytes')
  const all = new Set([path, `${path}.gz`, `${path}.br`])

  test('picks brotli, then gzip, then the file', async () => {
    const pick = (enc: string | undefined, have = all) =>
      serveBuilt(req(enc), path, (p) => have.has(p), { 'cache-control': 'c' })
    const br = pick('gzip, br')
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('content-type')).toContain('javascript')
    expect(br.headers.get('cache-control')).toBe('c')
    expect(await br.text()).toBe('brotli bytes')
    expect(pick('gzip').headers.get('content-encoding')).toBe('gzip')
    const plain = pick(undefined)
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('vary')).toBe('Accept-Encoding')
    expect(await plain.text()).toBe(big)
    const brOnly = pick('gzip, br', new Set([path, `${path}.br`]))
    expect(brOnly.headers.get('content-encoding')).toBe('br')
    expect(brOnly.headers.get('vary')).toBe('Accept-Encoding')
    expect(
      pick('gzip', new Set([path, `${path}.br`])).headers.get('vary'),
    ).toBe('Accept-Encoding')
    const none = pick('gzip, br', new Set([path]))
    expect(none.headers.get('content-encoding')).toBeNull()
    expect(none.headers.get('vary')).toBeNull()
  })
})
