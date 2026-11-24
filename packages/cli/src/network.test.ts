import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createSampleApi } from '@cobaltforge/api'
import { sampleTokens } from '@cobaltforge/api/sample'
import { clientFor } from './client'
import { signIn } from './commands/auth'
import { readCredentials } from './credentials'
import { run } from './main'
import { createSxMcpServer } from './mcp'
import type { Ctx } from './output'

/** The CLI against the API over real sockets, the way it will run against the hosted service. */
let server: ReturnType<typeof Bun.serve>
let base = ''
const api = createSampleApi({
  mount: '/v1',
  base: 'http://placeholder/v1',
  ephemeralSecrets: true,
})

async function cb(
  env: Record<string, string | undefined>,
  ...argv: Array<string>
) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  let out = ''
  let err = ''
  try {
    const code = await run([...argv, '--json'], {
      out: (s) => (out += s),
      err: (s) => (err += s),
    })
    return { code, out, err }
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => api.fetch(req),
  })
  base = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => void server.stop(true))

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-net-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('over the network', () => {
  const net = () => ({
    CB_API: base,
    CB_TOKEN: sampleTokens.dana,
    CB_CONFIG_DIR: dir,
    CB_ACCOUNT: undefined,
    CB_REPO: undefined,
  })

  test('the same command gives the same answer as in-process', async () => {
    const over = await cb(net(), 'change', 'view', '216', '-R', 'dana/gitfs')
    const local = await cb(
      { CB_API: undefined, CB_CONFIG_DIR: dir },
      'change',
      'view',
      '216',
      '-R',
      'dana/gitfs',
    )
    const strip = (t: string) => {
      const j = JSON.parse(t)
      // Links name the host that served them; everything else is the same.
      return JSON.stringify(j)
        .replaceAll(base, 'H')
        .replaceAll('http://placeholder/v1', 'H')
        .replaceAll('https://api.cobaltforge.dev/v1', 'H')
    }
    expect(over.code).toBe(0)
    expect(JSON.parse(over.out).blockers.length).toBeGreaterThan(0)
    expect(JSON.parse(strip(over.out))).toEqual(JSON.parse(strip(local.out)))
  })

  test('errors keep their code, hint and exit code over the wire', async () => {
    const r = await cb(net(), 'change', 'land', '216', '-R', 'dana/gitfs')
    expect(r.code).toBe(5)
    expect(JSON.parse(r.err).error).toMatchObject({ code: 'policy_blocked' })
    expect(
      (await cb(net(), 'change', 'view', '999', '-R', 'dana/gitfs')).code,
    ).toBe(3)
  })

  test('without a token it says how to sign in, and exits 4', async () => {
    const r = await cb({ ...net(), CB_TOKEN: undefined }, 'repo', 'list')
    expect(r.code).toBe(4)
    expect(JSON.parse(r.err).error.hint).toContain('cb auth login')
  })

  test('a wrong token is refused by the server', async () => {
    const r = await cb(
      { ...net(), CB_TOKEN: 'cbp_totally_wrong_token_value' },
      'repo',
      'list',
    )
    expect(r.code).toBe(4)
    expect(JSON.parse(r.err).error.code).toBe('token_invalid')
  })

  test('a renamed repository is followed, even for a write', async () => {
    const r = await cb(
      net(),
      'issue',
      'create',
      'Via the old name',
      '-R',
      'dana/git-fs',
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).title).toBe('Via the old name')
  })

  test('auth status asks the server who the token is', async () => {
    const r = JSON.parse((await cb(net(), 'auth', 'status')).out)
    expect(r).toMatchObject({
      authenticated: true,
      login: 'dana',
      account: 'dana',
    })
    expect(r.scopes).toContain('pulls:merge')
  })

  test('an agent token is limited: a triage bot cannot land', async () => {
    const r = await cb(
      { ...net(), CB_TOKEN: sampleTokens.issuesOnly },
      'change',
      'land',
      '216',
      '-R',
      'dana/gitfs',
    )
    expect(r.code).toBe(5)
    expect(JSON.parse(r.err).error.code).toBe('insufficient_scope')
  })
})

describe('signing in with a code', () => {
  /** A server that answers the way ours does, so the CLI's loop can be driven. */
  function stub(steps: Array<[number, Record<string, unknown>]>) {
    const calls: Array<{ url: string; body: string }> = []
    const queue = [...steps]
    const answer = (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body:
          typeof init?.body === 'string' ||
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : '',
      })
      if (url.endsWith('/oauth/register'))
        return Response.json({ client_id: 'cl_test' }, { status: 201 })
      if (url.endsWith('/oauth/device_authorization'))
        return Response.json({
          device_code: 'cbd_x',
          user_code: 'BCDF-GHJK',
          verification_uri: 'https://x/device',
          verification_uri_complete: 'https://x/device?user_code=BCDF-GHJK',
          expires_in: 900,
          interval: 1,
        })
      const [status, body] = queue.shift()!
      return Response.json(body, { status })
    }
    const f = ((url: string, init?: RequestInit) =>
      Promise.resolve(answer(url, init))) as unknown as typeof fetch
    return { f, calls }
  }
  const ctx = () => {
    const err: Array<string> = []
    return {
      err,
      ctx: {
        json: true,
        out: () => {},
        err: (s: string) => err.push(s),
        api: () => {
          throw new Error('no api')
        },
      } as unknown as Ctx,
    }
  }

  test('waits while pending, slows down when told, then saves the tokens readable by you only', async () => {
    process.env.CB_CONFIG_DIR = dir
    process.env.CB_API = 'https://api.example.com/v1'
    try {
      const { f, calls } = stub([
        [400, { error: 'authorization_pending' }],
        [400, { error: 'slow_down' }],
        [
          200,
          {
            access_token: 'cbo_access_token_value',
            refresh_token: 'cbf_refresh_token_value',
            expires_in: 3600,
            scope: 'repo:read',
          },
        ],
      ])
      const sleeps: Array<number> = []
      const c = ctx()
      await signIn(
        c.ctx,
        {},
        {
          fetch: f,
          sleep: (ms) => {
            sleeps.push(ms)
            return Promise.resolve()
          },
        },
      )
      // The code was shown on stderr, so stdout stays clean for scripts.
      expect(c.err[0]).toContain('BCDF-GHJK')
      expect(c.err[0]).toContain('https://x/device?user_code=BCDF-GHJK')
      expect(sleeps).toEqual([1000, 1000, 6000])
      const creds = readCredentials('https://api.example.com/v1')!
      expect(creds).toMatchObject({
        client_id: 'cl_test',
        access_token: 'cbo_access_token_value',
        refresh_token: 'cbf_refresh_token_value',
      })
      expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
      expect(calls.some((x) => x.body.includes('device_code=cbd_x'))).toBe(true)
      expect(readCredentials('https://other.example.com/v1')).toBeNull()
    } finally {
      delete process.env.CB_CONFIG_DIR
      delete process.env.CB_API
    }
  })

  test('a denied or expired code is a clear failure', async () => {
    process.env.CB_CONFIG_DIR = dir
    process.env.CB_API = 'https://api.example.com/v1'
    try {
      for (const [error, words] of [
        ['access_denied', 'denied'],
        ['expired_token', 'expired'],
      ] as const) {
        const { f } = stub([[400, { error }]])
        await expect(
          signIn(ctx().ctx, {}, { fetch: f, sleep: () => Promise.resolve() }),
        ).rejects.toMatchObject({
          code: 'login_failed',
          message: expect.stringContaining(words),
        })
      }
      expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
    } finally {
      delete process.env.CB_CONFIG_DIR
      delete process.env.CB_API
    }
  })

  test("with no API set it signs in to the host's and remembers it", async () => {
    process.env.CB_CONFIG_DIR = dir
    process.env.CB_HOST = 'https://forge.example.com'
    delete process.env.CB_API
    try {
      const { f, calls } = stub([
        [
          200,
          {
            access_token: 'cbo_access_token_value',
            refresh_token: 'cbf_refresh_token_value',
            expires_in: 3600,
            scope: 'repo:read',
          },
        ],
      ])
      await signIn(ctx().ctx, {}, { fetch: f, sleep: () => Promise.resolve() })
      expect(calls[0].url).toBe(
        'https://forge.example.com/api/v1/oauth/register',
      )
      const forge = 'https://forge.example.com/api/v1'
      expect(readCredentials(forge)?.access_token).toBe(
        'cbo_access_token_value',
      )
      expect(
        JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).api,
      ).toBe(forge)
    } finally {
      delete process.env.CB_CONFIG_DIR
      delete process.env.CB_HOST
    }
  })

  test('against the real server: the whole device flow, then the saved token works and refreshes', async () => {
    const real = createSampleApi({
      mount: '/v1',
      base: 'http://placeholder/v1',
      ephemeralSecrets: true,
    })
    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => real.fetch(req),
    })
    const url = `http://127.0.0.1:${srv.port}/v1`
    const env = {
      CB_API: url,
      CB_CONFIG_DIR: dir,
      CB_TOKEN: undefined,
      CB_ACCOUNT: undefined,
    }
    try {
      // The "browser": sign in as dana and approve the code the CLI prints.
      const approve = async (stderrText: string) => {
        const userCode = /code is ([A-Z]{4}-[A-Z]{4})/.exec(stderrText)![1]
        const session = await fetch(`${url}/oauth/session`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://cobaltforge.dev',
          },
          body: 'handle=dana&return_to=/',
        })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const page = await (
          await fetch(`${url}/oauth/device`, { headers: { cookie } })
        ).text()
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]
        const post = (data: Record<string, string>) =>
          fetch(`${url}/oauth/device`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              cookie,
            },
            body: new URLSearchParams({ csrf, ...data }),
          })
        await post({ user_code: userCode })
        await post({ user_code: userCode, decision: 'approve' })
      }
      Object.assign(process.env, { CB_API: url, CB_CONFIG_DIR: dir })
      delete process.env.CB_TOKEN
      const c = ctx()
      const loginDone = signIn(
        c.ctx,
        {},
        {
          fetch,
          // The real server enforces its polling interval; wait it out, then approve once the code is shown.
          sleep: async (ms) => {
            if (c.err.length && !approved) {
              approved = true
              await approve(c.err[0])
            }
            await new Promise((r) => setTimeout(r, Math.max(ms, 5200)))
          },
        },
      )
      let approved = false
      await loginDone
      const creds = readCredentials(url)!
      expect(creds.access_token).toMatch(/^cbo_/)
      const who = await cb(env, 'auth', 'status')
      expect(JSON.parse(who.out)).toMatchObject({
        authenticated: true,
        via: 'credentials',
      })
      // With a stored token and no CB_TOKEN, calls work.
      const list = await cb(env, 'repo', 'list')
      expect(list.code, list.err).toBe(0)
      // An expired token is refreshed, and the new refresh token is saved.
      const file = join(dir, 'credentials.json')
      const stale = { ...creds, expires_at: Date.now() - 1000 }
      await Bun.write(file, JSON.stringify(stale))
      expect((await cb(env, 'repo', 'list')).code).toBe(0)
      const after = JSON.parse(readFileSync(file, 'utf8'))
      expect(after.refresh_token).not.toBe(creds.refresh_token)
      expect(after.expires_at).toBeGreaterThan(Date.now())
      // Logging out revokes on the server.
      expect((await cb(env, 'auth', 'logout')).code).toBe(0)
      expect(existsSync(file)).toBe(false)
      const dead = await fetch(`${url}/auth/principal`, {
        headers: { authorization: `Bearer ${after.access_token}` },
      })
      expect(dead.status).toBe(401)
    } finally {
      delete process.env.CB_API
      delete process.env.CB_CONFIG_DIR
      void srv.stop(true)
    }
  }, 30_000)
})

describe('MCP carries the caller’s token', () => {
  // Over HTTP, as the hosted endpoint serves it, at the 2026-07-28
  // revision: no session, the version and method on every request.
  async function connect(token: string) {
    const { Client, StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/client')
    const { createMcpHandler } = await import('@modelcontextprotocol/server')
    const mcp = createMcpHandler(() =>
      createSxMcpServer({
        client: clientFor(base, token, (req) => fetch(req)),
      }),
    )
    const c = new Client(
      { name: 'test', version: '0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
        fetch: (input, init) => mcp.fetch(new Request(input, init)),
      }),
    )
    return c
  }
  const text = (r: unknown) =>
    (r as { content: Array<{ text: string }> }).content[0].text

  test('a tool does what the token allows and no more', async () => {
    const dana = await connect(sampleTokens.dana)
    const ok = await dana.callTool({
      name: 'get_change',
      arguments: { repo: 'dana/gitfs', id: '216' },
    })
    expect(JSON.parse(text(ok)).number).toBe(216)
    const triage = await connect(sampleTokens.issuesOnly)
    const denied = await triage.callTool({
      name: 'land_change',
      arguments: { repo: 'dana/gitfs', id: '216' },
    })
    expect((denied as { isError?: boolean }).isError).toBe(true)
    expect(JSON.parse(text(denied)).error.code).toBe('insufficient_scope')
    const issue = await triage.callTool({
      name: 'create_issue',
      arguments: { repo: 'dana/gitfs', title: 'From the triage bot' },
    })
    expect((issue as { isError?: boolean }).isError).toBeUndefined()
  })

  test('check_policy answers a blocked policy without isError, but keeps permission errors', async () => {
    const dana = await connect(sampleTokens.dana)
    const blocked = await dana.callTool({
      name: 'check_policy',
      arguments: { repo: 'dana/gitfs', change: '216' },
    })
    expect((blocked as { isError?: boolean }).isError).toBeUndefined()
    const body = JSON.parse(text(blocked))
    expect(body.allowed).toBe(false)
    expect(body.requirements.length).toBeGreaterThan(0)

    // The triage bot has repo:read but not pulls:read.
    const triage = await connect(sampleTokens.issuesOnly)
    const denied = await triage.callTool({
      name: 'check_policy',
      arguments: { repo: 'dana/gitfs', change: '216' },
    })
    expect((denied as { isError?: boolean }).isError).toBe(true)
    expect(JSON.parse(text(denied)).error.code).toBe('insufficient_scope')
  })

  test('search_operations finds any operation and describes it in full', async () => {
    const dana = await connect(sampleTokens.dana)
    const found = JSON.parse(
      text(
        await dana.callTool({
          name: 'search_operations',
          arguments: { query: 'label delete' },
        }),
      ),
    )
    expect(found.total).toBeGreaterThan(100)
    expect(found.operations[0].id).toBe('labels.delete')
    const one = JSON.parse(
      text(
        await dana.callTool({
          name: 'search_operations',
          arguments: { id: 'issues.create' },
        }),
      ),
    )
    expect(one.method).toBe('POST')
    expect(one.params.map((p: { name: string }) => p.name)).toEqual([
      'owner',
      'repo',
    ])
    expect(one.body.properties.title.type).toBe('string')
    // An operation whose answer is a secret is listed, and marked.
    const secret = JSON.parse(
      text(
        await dana.callTool({
          name: 'search_operations',
          arguments: { id: 'tokens.create' },
        }),
      ),
    )
    expect(secret.callable).toBe(false)
  })

  test('call_operation runs any operation as the token, and asks before destroying', async () => {
    const dana = await connect(sampleTokens.dana)
    const call = async (args: Record<string, unknown>) => {
      const r = (await dana.callTool({
        name: 'call_operation',
        arguments: args,
      })) as { isError?: boolean }
      return { error: r.isError === true, body: JSON.parse(text(r)) }
    }
    const read = await call({
      id: 'issues.list',
      params: { owner: 'dana', repo: 'gitfs', state: 'open' },
    })
    expect(read.error).toBe(false)
    expect(read.body.status).toBe(200)
    expect(read.body.data.data.length).toBeGreaterThan(0)

    const made = await call({
      id: 'labels.create',
      params: { owner: 'dana', repo: 'gitfs' },
      body: { name: 'from-mcp', color: 'blue' },
    })
    expect(made.error).toBe(false)
    expect(made.body.data.name).toBe('from-mcp')

    const unasked = await call({
      id: 'labels.delete',
      params: { owner: 'dana', repo: 'gitfs', label: 'from-mcp' },
    })
    expect(unasked.error).toBe(true)
    expect(unasked.body.error.code).toBe('confirmation_required')
    const dry = await call({
      id: 'labels.delete',
      params: { owner: 'dana', repo: 'gitfs', label: 'from-mcp' },
      dry_run: true,
    })
    expect(dry.error).toBe(false)
    expect(dry.body.dry_run).toBe(true)
    const gone = await call({
      id: 'labels.delete',
      params: { owner: 'dana', repo: 'gitfs', label: 'from-mcp' },
      confirm: true,
    })
    expect(gone.error).toBe(false)

    expect(
      (await call({ id: 'labels.delete', params: {} })).body.error.code,
    ).toBe('confirmation_required')
    const missing = await call({
      id: 'labels.list',
      params: { owner: 'dana' },
    })
    expect(missing.body.error.code).toBe('missing_parameter')
    const secret = await call({ id: 'tokens.create', body: { name: 'x' } })
    expect(secret.body.error.code).toBe('not_callable')

    // The token's scopes still hold: the triage bot cannot land.
    const triage = await connect(sampleTokens.issuesOnly)
    const denied = (await triage.callTool({
      name: 'call_operation',
      arguments: {
        id: 'changes.land',
        params: { owner: 'dana', repo: 'gitfs', number: '216' },
        confirm: true,
      },
    })) as { isError?: boolean }
    expect(denied.isError).toBe(true)
    expect(JSON.parse(text(denied)).error.code).toBe('insufficient_scope')
  })
})
