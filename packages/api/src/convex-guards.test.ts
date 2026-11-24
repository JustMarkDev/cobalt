import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const guard =
  /\b(signedIn|actorOf|system|resolve|who|assertSecret|bodyOf|payer)\(/

const PUBLIC: Record<string, string> = {
  'profiles.ts:get': 'A profile page: name, bio and status are public.',
  'auth.ts:getCurrentUser': 'The caller’s own sign-in, or null.',
  'forge/people.ts:listFollows': 'Followers and following are public.',
  'forge/people.ts:peopleVersion': 'A cache tag: a counter, nothing private.',
  'forge/events.ts:head': 'Feed position counters, nothing private.',
  'forge/accounts.ts:version': 'A cache tag for an account page.',
  'forge/accounts.ts:listMembers': 'Organization members are public.',
  'forge/accounts.ts:membersVersion': 'A cache tag for the member list.',
}

function publicFunctions() {
  const root = new URL('../../../convex/', import.meta.url).pathname
  const found: Array<{ id: string; body: string }> = []
  for (const file of new Bun.Glob('**/*.ts').scanSync(root)) {
    if (file.startsWith('_generated/') || file.includes('.test.')) continue
    const src = readFileSync(`${root}${file}`, 'utf8')
    const starts = [...src.matchAll(/^export const (\w+) = (\w+)\(/gm)]
    starts.forEach((m, i) => {
      if (!['query', 'mutation', 'action'].includes(m[2])) return
      const end = starts[i + 1]?.index ?? src.length
      found.push({ id: `${file}:${m[1]}`, body: src.slice(m.index, end) })
    })
  }
  return found
}

describe('public Convex functions', () => {
  const all = publicFunctions()

  test('there are some to check', () => {
    expect(all.length).toBeGreaterThan(100)
  })

  test('each asks who is calling, or says why it need not', () => {
    const open = all
      .filter((f) => !guard.test(f.body) && !(f.id in PUBLIC))
      .map((f) => f.id)
    expect(open).toEqual([])
  })

  test('the list of public ones has nothing stale in it', () => {
    const ids = new Set(all.map((f) => f.id))
    expect(Object.keys(PUBLIC).filter((id) => !ids.has(id))).toEqual([])
  })
})

describe('an anonymous caller', () => {
  const world = async () => {
    const { convexTest } = await import('convex-test')
    const { default: schema } = await import('../../../convex/schema')
    const { load } = await import('../../../convex/seed')
    const { exportWorld } = await import('./seed-export')
    const { createSampleApi } = await import('./index')
    const { convexFactory } = await import('./convex-testing')
    const dir = new URL('../../../convex/', import.meta.url).pathname
    const modules: Record<string, () => Promise<never>> = {}
    for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
      if (!f.endsWith('.d.ts') && !f.includes('.test.'))
        modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>
    let from: Parameters<typeof convexFactory>[0] | undefined
    createSampleApi({
      ephemeralSecrets: true,
      domainFactory: (a) => {
        from = a
        return convexFactory(a)
      },
    })
    await from!.memory.svc.secrets
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await load(ctx, exportWorld(from!.memory, from!.auth))
    })
    const { makeFunctionReference } = await import('convex/server')
    return (name: string, args: Record<string, unknown>) =>
      t.query(makeFunctionReference<'query'>(name as never), args as never)
  }

  test('sees no private repository’s name or id', async () => {
    const q = await world()
    const repos = JSON.parse(
      (await q('forge/people:profileRepos', {
        handle: 'dana',
        since: 0,
      })) as string,
    ) as Array<string>
    expect(repos).toContain('dana/tinyqueue')
    expect(repos).not.toContain('dana/notes')
    for (const [name, args] of [
      ['forge/repos:idForHistory', { full: 'dana/notes' }],
      ['forge/repos:canonicalName', { full: 'dana/notes' }],
      ['forge/repos:canActAs', { login: 'dana', account: 'northwind' }],
      ['forge/changes:operationRepoId', { id: 'op_x' }],
      ['forge/insights:statusFacts', {}],
    ] as const)
      await expect(q(name, args)).rejects.toThrow()
  })
})
