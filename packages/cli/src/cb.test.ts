import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parse } from './args'
import { run } from './main'
import { scrub } from './secrets'

async function cb(...argv: Array<string>) {
  let out = ''
  let err = ''
  const code = await run([...argv, '--json'], {
    out: (s) => (out += s),
    err: (s) => (err += s),
  })
  return { code, out, err }
}

describe('parse', () => {
  test('flags, shorts and positionals', () => {
    const p = parse(['change', 'view', '-R', 'dana/gitfs', '--json', 'ch_1'])
    expect(p.positionals).toEqual(['change', 'view', 'ch_1'])
    expect(p.flags).toEqual({ repo: 'dana/gitfs', json: true })
  })

  test('--private is a boolean even before the name', () => {
    const p = parse(['repo', 'create', '--private', 'notes'])
    expect(p.positionals).toEqual(['repo', 'create', 'notes'])
    expect(p.flags.private).toBe(true)
  })
})

describe('scrub', () => {
  test('replaces long values and their encodings everywhere', () => {
    expect(scrub('token=hunter2 again hunter2', { TOKEN: 'hunter2' })).toBe(
      'token=«TOKEN» again «TOKEN»',
    )
    expect(
      scrub(Buffer.from('hunter2').toString('base64'), { TOKEN: 'hunter2' }),
    ).toBe('«TOKEN»')
  })

  test('redacts short values only where they stand alone', () => {
    expect(scrub('pin 42 port 421 42x', { PIN: '42' })).toBe(
      'pin «PIN» port 421 42x',
    )
    expect(scrub('a cat', { A: 'a' })).toBe('«A» cat')
    expect(scrub('path/to', { SLASH: '/' })).toBe('path/to')
    expect(scrub('at https://example.com/a', { SLASH: '/' })).toBe(
      'at https://example.com/a',
    )
    expect(scrub('a / b', { SLASH: '/' })).toBe('a «SLASH» b')
    expect(scrub('run --flag and -- again', { DASHES: '--' })).toBe(
      'run --flag and «DASHES» again',
    )
    expect(scrub('a.b and a.c', { DOT: 'a.' })).toBe('a.b and a.c')
    expect(scrub('see a. now', { DOT: 'a.' })).toBe('see «DOT» now')
    expect(scrub('{"pin":42}', { PIN: '42' })).toBe('{"pin":«PIN»}')
    expect(scrub(':42', { PIN: '42' })).toBe(':«PIN»')
    expect(scrub('42=', { PIN: '42' })).toBe('«PIN»=')
  })

  test('leaves empty values alone', () => {
    expect(scrub('text', { EMPTY: '' })).toBe('text')
  })
})

describe('cb', () => {
  test('never prompts: a missing repo is an error with a hint', async () => {
    // Outside a clone with no -R the repo cannot be known.
    const cwd = process.cwd()
    const repo = process.env.CB_REPO
    delete process.env.CB_REPO
    process.chdir(mkdtempSync(join(tmpdir(), 'cb-')))
    try {
      const r = await cb('change', 'list')
      expect(r.code).toBe(2)
      expect(JSON.parse(r.err).error.code).toBe('repo_unknown')
      expect(JSON.parse(r.err).error.hint).toContain('-R')
    } finally {
      process.chdir(cwd)
      if (repo !== undefined) process.env.CB_REPO = repo
    }
  })

  test('creating a change twice adds a patch set, not a duplicate', async () => {
    const args = [
      'change',
      'create',
      '-R',
      'dana/gitfs',
      '--branch',
      'x',
      '--title',
      'T',
    ]
    const first = JSON.parse((await cb(...args)).out)
    const second = JSON.parse((await cb(...args)).out)
    expect(first.action).toBe('created')
    expect(second.action).toBe('patch_set_added')
    expect(second.id).toBe(first.id)
    expect(second.patch_set_count).toBe(2)
  })

  test('landing a blocked change exits 5 and says why', async () => {
    const r = await cb('change', 'land', '216', '-R', 'dana/gitfs')
    expect(r.code).toBe(5)
    expect(JSON.parse(r.err).error.code).toBe('policy_blocked')
  })

  test('--dry-run changes nothing', async () => {
    const r = await cb(
      'issue',
      'create',
      'Brand new',
      '-R',
      'dana/gitfs',
      '--dry-run',
    )
    expect(JSON.parse(r.out).created).toBe(true)
    const list = JSON.parse(
      (await cb('issue', 'list', '--state', 'all', '-R', 'dana/gitfs')).out,
    )
    expect(list.some((i: { title: string }) => i.title === 'Brand new')).toBe(
      false,
    )
  })

  test('env list never contains values', async () => {
    const r = await cb('env', 'list', '-R', 'dana/gitfs')
    expect(r.out).not.toContain('value')
    expect(JSON.parse(r.out)[0]).toMatchObject({
      name: 'DATABASE_URL',
      secret: true,
      environments: ['development', 'production'],
    })
  })
})

describe('agent support', () => {
  test('every documented command has a handler', async () => {
    const { schema } = await import('./schema')
    for (const c of schema) {
      const r = await cb(...c.command.split(' '), '--help')
      expect(r.code).toBe(0)
    }
    const top = JSON.parse((await cb('commands')).out) as {
      commands: Array<{ command: string }>
    }
    expect(top.commands.length).toBe(schema.length)
  })

  test('a mistyped command suggests the right one', async () => {
    const r = await cb('chnge', 'list')
    expect(r.code).toBe(2)
    expect(JSON.parse(r.err).error.hint).toContain('cb change')
  })

  test('the skill installs once and is then unchanged', async () => {
    const { installSkill } = await import('./skill')
    const dir = mkdtempSync(join(tmpdir(), 'cb-'))
    expect(installSkill(dir, 'claude').action).toBe('created')
    expect(installSkill(dir, 'claude').action).toBe('unchanged')
    expect(installSkill(dir, 'agents').action).toBe('created')
    expect(installSkill(dir, 'agents').action).toBe('unchanged')
  })
})

describe('mcp', () => {
  async function client() {
    const { Client } = await import('@modelcontextprotocol/client')
    const { InMemoryTransport } = await import('@modelcontextprotocol/server')
    const { createSxMcpServer } = await import('./mcp')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createSxMcpServer().connect(b)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(a)
    return c
  }
  const text = (r: unknown) =>
    (r as { content: Array<{ text: string }> }).content[0].text

  test('lists tools with read-only hints and reads a change', async () => {
    const c = await client()
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name)).toContain('get_change')
    expect(
      tools.find((t) => t.name === 'get_change')?.annotations?.readOnlyHint,
    ).toBe(true)
    expect(
      tools.find((t) => t.name === 'land_change')?.annotations?.destructiveHint,
    ).toBe(true)
    const r = await c.callTool({
      name: 'get_change',
      arguments: { repo: 'dana/gitfs', id: '216' },
    })
    expect(JSON.parse(text(r)).blockers.length).toBeGreaterThan(0)
  })

  test('a blocked landing is an error with a hint, not a crash', async () => {
    const c = await client()
    const r = await c.callTool({
      name: 'land_change',
      arguments: { repo: 'dana/gitfs', id: '216' },
    })
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(JSON.parse(text(r)).error.code).toBe('policy_blocked')
  })

  test('working on a change puts the agent in its room', async () => {
    const c = await client()
    await c.callTool({
      name: 'get_change',
      arguments: { repo: 'dana/gitfs', id: '216' },
    })
    const r = await c.callTool({
      name: 'get_presence',
      arguments: { repo: 'dana/gitfs', kind: 'change', id: '216' },
    })
    const p = JSON.parse(text(r))
    expect(p.object).toBe('presence')
    expect(p.viewers.length).toBe(1)
  })

  test('tool schemas are compact and a timeline comes a page at a time', async () => {
    const c = await client()
    const listed = JSON.stringify((await c.listTools()).tools)
    expect(listed).not.toContain('$schema')
    expect(listed).not.toContain('9007199254740991')
    const page = (args: Record<string, unknown>) =>
      c
        .callTool({
          name: 'get_timeline',
          arguments: { repo: 'dana/gitfs', kind: 'change', id: '216', ...args },
        })
        .then(
          (r) =>
            JSON.parse(text(r)) as {
              total: number
              from: number
              entries: Array<unknown>
              earlier: { count: number } | null
            },
        )
    const newest = await page({ limit: 4 })
    expect(newest.entries).toHaveLength(4)
    expect(newest.from).toBe(newest.total - 4)
    expect(newest.earlier?.count).toBe(newest.from)
    const older = await page({ limit: 4, before: newest.from })
    expect(older.from).toBe(newest.from - 4)
    const all = await page({})
    expect(all.entries).toHaveLength(all.total)
  })

  test('serves the skill as a resource', async () => {
    const c = await client()
    const r = await c.readResource({ uri: 'cb://skill' })
    expect((r.contents[0] as { text: string }).text).toContain('cb context')
  })
})

describe('secrets through your login', () => {
  // dana's agent on her laptop: her login, a narrower token, the same team.
  const asAgent = async <T>(fn: () => Promise<T>) => {
    process.env.CB_SAMPLE_TOKEN = 'scoped'
    process.env.CB_MODEL = 'Claude Opus 5.5'
    try {
      return await fn()
    } finally {
      delete process.env.CB_SAMPLE_TOKEN
      delete process.env.CB_MODEL
    }
  }

  test("an agent on a team member's machine runs with values, scrubbed from what it sees", async () => {
    const ran = await asAgent(() =>
      cb(
        'env',
        'run',
        '-R',
        'dana/gitfs',
        '--',
        'sh',
        '-c',
        'echo "db=$DATABASE_URL port=$API_PORT stripe=[$STRIPE_KEY]"; printf %s "$DATABASE_URL" | base64',
      ),
    )
    expect(ran.code).toBe(0)
    const out = JSON.parse(ran.out)
    expect(out.stdout).toContain('db=«DATABASE_URL»')
    // Production-only values are simply not there in development.
    expect(out.stdout).toContain('stripe=[]')
    expect(out.stdout).toContain('port=8080') // public values are not scrubbed
    expect(ran.out).not.toContain('hunter2')
    expect(ran.out).not.toContain(
      Buffer.from(
        'postgres://dev:hunter2-dev-only@localhost:5432/gitfs',
      ).toString('base64'),
    )
    expect(out.redacted).toContain('DATABASE_URL')
  })

  test('production waits for the person to confirm this login, and says where', async () => {
    const r = await asAgent(() =>
      cb(
        'env',
        'run',
        '--env',
        'production',
        '-R',
        'dana/gitfs',
        '--',
        'echo',
        'hi',
      ),
    )
    expect(r.code).toBe(6)
    const e = JSON.parse(r.err).error
    expect(e.code).toBe('confirmation_required')
    expect(e.hint).toContain('confirm=cnf_')
    const list = JSON.parse(
      (await asAgent(() => cb('env', 'confirmations', '-R', 'dana/gitfs'))).out,
    ) as Array<{ state: string; device: string }>
    expect(list[0]).toMatchObject({ state: 'pending', device: 'Laptop' })
  })

  test('no plaintext file unless asked for by name', async () => {
    const r = await cb('env', 'pull', '-R', 'dana/gitfs', '--dry-run')
    expect(r.code).toBe(2)
    expect(JSON.parse(r.err).error.code).toBe('plaintext_refused')
    const ok = await cb(
      'env',
      'pull',
      '-R',
      'dana/gitfs',
      '--plaintext',
      '--dry-run',
    )
    expect(ok.code).toBe(0)
  })
})

describe('accounts', () => {
  let dir = ''
  beforeEach(() => {
    // Settings go to a folder of their own, so a test never touches yours.
    dir = mkdtempSync(join(tmpdir(), 'cb-accounts-'))
    process.env.CB_CONFIG_DIR = dir
    delete process.env.CB_ACCOUNT
    delete process.env.CB_REPO
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.CB_CONFIG_DIR
    delete process.env.CB_ACCOUNT
    delete process.env.CB_REPO
  })
  const json = (r: { out: string }) => JSON.parse(r.out)

  test('list shows yourself and your organizations, with your role in each', async () => {
    const rows = json(await cb('account', 'list')) as Array<{
      handle: string
      kind: string
      role: string
      active: boolean
    }>
    expect(rows.map((r) => [r.handle, r.kind, r.role])).toEqual([
      ['dana', 'person', 'owner'],
      ['northwind', 'organization', 'owner'],
      ['lumen-studio', 'organization', 'member'],
    ])
    expect(rows.filter((r) => r.active).map((r) => r.handle)).toEqual(['dana'])
  })

  test('by default you act as yourself, and it says why', async () => {
    const cur = json(await cb('account', 'current'))
    expect(cur).toMatchObject({
      handle: 'dana',
      kind: 'person',
      from: 'default',
      login: 'dana',
    })
  })

  test('-A acts as another account for one command, and saves nothing', async () => {
    const cur = json(await cb('account', 'current', '-A', 'northwind'))
    expect(cur).toMatchObject({ handle: 'northwind', from: 'flag' })
    expect(json(await cb('account', 'current')).handle).toBe('dana')
  })

  test('an account you cannot act as is an error with a hint, exit 3', async () => {
    const r = await cb('account', 'current', '-A', 'someone-else')
    expect(r.code).toBe(3)
    const e = JSON.parse(r.err).error
    expect(e.code).toBe('account_not_found')
    expect(e.hint).toContain('cb account list')
    expect((await cb('account', 'switch', 'someone-else')).code).toBe(3)
  })

  test('switch is saved, and repeating it changes nothing', async () => {
    const first = json(await cb('account', 'switch', 'northwind'))
    expect(first).toMatchObject({
      handle: 'northwind',
      switched: true,
      previous: 'dana',
    })
    expect(json(await cb('account', 'current'))).toMatchObject({
      handle: 'northwind',
      from: 'config',
    })
    const again = json(await cb('account', 'switch', 'northwind'))
    expect(again.switched).toBe(false)
    // Back to yourself is the same kind of switch.
    expect(json(await cb('account', 'switch', 'dana')).switched).toBe(true)
  })

  test('--dry-run switches nothing', async () => {
    const r = json(await cb('account', 'switch', 'northwind', '--dry-run'))
    expect(r.switched).toBe(true)
    expect(json(await cb('account', 'current')).handle).toBe('dana')
  })

  test('in a clone you act as the repository owner, with no switching', async () => {
    const cur = json(await cb('account', 'current', '-R', 'northwind/relay'))
    expect(cur).toMatchObject({ handle: 'northwind', from: 'repo' })
    // A saved switch does not beat the repository you are working in.
    await cb('account', 'switch', 'dana')
    process.env.CB_REPO = 'northwind/relay'
    expect(json(await cb('account', 'current')).from).toBe('repo')
  })

  test('precedence: flag, CB_ACCOUNT, repository, saved, you', async () => {
    await cb('account', 'switch', 'lumen-studio')
    expect(json(await cb('account', 'current')).from).toBe('config')
    process.env.CB_REPO = 'northwind/relay'
    expect(json(await cb('account', 'current')).handle).toBe('northwind')
    process.env.CB_ACCOUNT = 'dana'
    expect(json(await cb('account', 'current'))).toMatchObject({
      handle: 'dana',
      from: 'env',
    })
    expect(
      json(await cb('account', 'current', '-A', 'lumen-studio')),
    ).toMatchObject({ handle: 'lumen-studio', from: 'flag' })
  })

  test('switching says so when CB_ACCOUNT would still win', async () => {
    process.env.CB_ACCOUNT = 'dana'
    const r = json(await cb('account', 'switch', 'northwind'))
    expect(r.overriddenBy).toBe('CB_ACCOUNT')
  })

  test('repo list is the account you act as; --all is every account', async () => {
    const mine = json(await cb('repo', 'list')) as Array<{ slug: string }>
    expect(mine.map((r) => r.slug).sort()).toEqual([
      'dana/gitfs',
      'dana/notes',
      'dana/tinyqueue',
    ])
    const org = json(await cb('repo', 'list', '-A', 'northwind')) as Array<{
      slug: string
    }>
    expect(org.map((r) => r.slug)).toEqual(['northwind/relay'])
    const all = json(await cb('repo', 'list', '--all')) as Array<{
      slug: string
    }>
    expect(all.map((r) => r.slug).sort()).toEqual([
      'dana/gitfs',
      'dana/notes',
      'dana/tinyqueue',
      'northwind/relay',
    ])
  })

  test('a bare repo name is created in the account you act as', async () => {
    const r = json(
      await cb('repo', 'create', 'tools', '-A', 'northwind', '--dry-run'),
    )
    expect(r.slug).toBe('northwind/tools')
    const own = json(await cb('repo', 'create', 'notes', '--dry-run'))
    expect(own.slug).toBe('dana/notes')
  })

  test('members cannot create in an organization; the hint says who can', async () => {
    const r = await cb('repo', 'create', 'lumen-studio/x', '--dry-run')
    expect(r.code).toBe(5)
    const e = JSON.parse(r.err).error
    expect(e.code).toBe('forbidden')
    expect(e.hint).toContain('owner or admin')
  })

  test('creating under an account you cannot act as is not found', async () => {
    const r = await cb('repo', 'create', 'stranger/x', '--dry-run')
    expect(r.code).toBe(3)
    expect(JSON.parse(r.err).error.code).toBe('not_found')
  })

  test('context and auth status name the account', async () => {
    const ctx = json(await cb('context', '-R', 'northwind/relay'))
    expect(ctx.account).toEqual({
      handle: 'northwind',
      kind: 'organization',
      role: 'owner',
    })
    process.env.CB_TOKEN = 'cbt_test'
    try {
      expect(json(await cb('auth', 'status', '-A', 'northwind')).account).toBe(
        'northwind',
      )
    } finally {
      delete process.env.CB_TOKEN
    }
  })

  test('the MCP server can list accounts', async () => {
    const { Client } = await import('@modelcontextprotocol/client')
    const { InMemoryTransport } = await import('@modelcontextprotocol/server')
    const { createSxMcpServer } = await import('./mcp')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createSxMcpServer().connect(b)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(a)
    const { tools } = await c.listTools()
    expect(
      tools.find((t) => t.name === 'list_accounts')?.annotations?.readOnlyHint,
    ).toBe(true)
    const r = (await c.callTool({ name: 'list_accounts', arguments: {} })) as {
      content: Array<{ text: string }>
    }
    expect(
      (JSON.parse(r.content[0].text) as Array<{ handle: string }>).map(
        (x) => x.handle,
      ),
    ).toContain('northwind')
  })
})

describe('hand-off', () => {
  test('an issue, a change or a failing pipeline run, never a value', async () => {
    for (const [subject, type] of [
      ['216', 'change'],
      ['run:1839', 'pipeline'],
    ] as const) {
      const r = await cb('handoff', subject, '-R', 'dana/gitfs', '--to', 'boat')
      expect(r.code).toBe(0)
      const out = JSON.parse(r.out)
      expect(out.type).toBe(type)
      expect(out.command).toContain('boat')
      expect(r.out).not.toContain('hunter2')
    }
    const missing = await cb('handoff', 'run:999999', '-R', 'dana/gitfs')
    expect(JSON.parse(missing.err).error.code).toBe('not_found')
  })
})

// Last: imports add repositories to the sample state other tests count.
describe('import', () => {
  test('from a host and owner/name, or from its address, once', async () => {
    const made = await cb('import', 'github', 'dana-okafor/recipes')
    expect(made.code, made.err).toBe(0)
    expect(JSON.parse(made.out)).toMatchObject({
      slug: 'dana/recipes',
      created: true,
      upstream: { host: 'github', slug: 'dana-okafor/recipes' },
    })
    const again = await cb(
      'import',
      'https://github.com/dana-okafor/recipes.git',
    )
    expect(JSON.parse(again.out)).toMatchObject({
      slug: 'dana/recipes',
      created: false,
    })
    const placed = await cb(
      'import',
      'git@gitlab.com:dana/zine.git',
      '--as',
      'northwind/zine',
      '--private',
    )
    expect(JSON.parse(placed.out)).toMatchObject({
      slug: 'northwind/zine',
      visibility: 'private',
    })
    const list = JSON.parse((await cb('import', 'list')).out) as Array<{
      repo: string
    }>
    expect(list.map((i) => i.repo)).toContain('dana/recipes')
  })

  test('a dry run makes nothing', async () => {
    const r = await cb('import', 'codeberg', 'dana/quiet', '--dry-run')
    expect(JSON.parse(r.out)).toMatchObject({ dryRun: true })
    const list = JSON.parse((await cb('import', 'list')).out) as Array<{
      repo: string
    }>
    expect(list.map((i) => i.repo)).not.toContain('dana/quiet')
  })

  test('a host it cannot import from is a usage error with an example', async () => {
    const r = await cb('import', 'https://bitbucket.org/dana/x')
    expect(r.code).toBe(2)
    expect(JSON.parse(r.err).error.hint).toContain('cb import github')
  })
})

describe('runners', () => {
  test('register shows the token once; start runs a job with it; revoke ends it', async () => {
    const made = await cb(
      'runner',
      'register',
      'cli-runner',
      '--concurrency',
      '1',
    )
    expect(made.code).toBe(0)
    const r = JSON.parse(made.out)
    expect(r.secret).toMatch(/^cbr_/)
    const listed = JSON.parse((await cb('runner', 'list')).out) as Array<{
      id: string
      secret: string | null
    }>
    expect(listed.find((x) => x.id === r.id)?.secret).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'cb-runner-'))
    process.env.CB_RUNNER_TOKEN = r.secret
    try {
      const ran = await cb('runner', 'start', '--once', '--workdir', dir)
      expect(ran.code).toBe(0)
      const out = JSON.parse(ran.out)
      expect(out.ran === null || typeof out.ran.run === 'number').toBe(true)
      if (out.ran) expect(out.status).toBe('success')
      expect((await cb('runner', 'revoke', r.id)).code).toBe(0)
      const after = await cb('runner', 'start', '--once', '--workdir', dir)
      expect(after.code).toBe(4)
    } finally {
      delete process.env.CB_RUNNER_TOKEN
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pipeline resume says what it needs', async () => {
    const r = await cb('pipeline', 'resume', 'x')
    expect(r.code).toBe(2)
  })
})
