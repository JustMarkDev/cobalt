import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test'
import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'
import { api, internal } from '../../../convex/_generated/api'
import schema from '../../../convex/schema'

process.env.API_JWT_ISSUER = 'https://convex.test'

const dir = new URL('../../../convex/', import.meta.url).pathname
const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

function component(entry: string) {
  const root = `${entry.slice(0, entry.lastIndexOf('/dist/'))}/dist/component/`
  const mods: Record<string, () => Promise<never>> = {}
  for (const f of new Bun.Glob('**/*.js').scanSync(root))
    mods[`./component/${f}`] = () => import(`${root}${f}`) as Promise<never>
  const own = require(`${root}schema.js`) as { default: never }
  return { schema: own.default, modules: mods }
}
const betterAuth = component(require.resolve('@convex-dev/better-auth'))

const START = Date.parse('2026-11-27T12:00:00Z')
beforeEach(() => setSystemTime(new Date(START)))
afterEach(() => setSystemTime())

async function world() {
  const t = convexTest(schema, modules)
  t.registerComponent('betterAuth', betterAuth.schema, betterAuth.modules)
  for (const handle of ['alice', 'bob', 'carol'])
    await t.run((ctx) =>
      ctx.db.insert('accounts', {
        kind: 'person',
        handle,
        name: handle,
        bio: '',
        authId: `user_${handle}`,
        publicId: `acc_${handle}`,
        created: START,
        updated: START,
        version: 1,
        aclRev: 0,
      }),
    )
  const as = (handle: string) =>
    t.withIdentity({
      subject: `user_${handle}`,
      email: `${handle}@mail.test`,
      name: handle,
    })
  const alice = as('alice')
  await alice.mutation(api.forge.accounts.createOrganization, {
    handle: 'acme',
  })
  await alice.mutation(api.forge.accounts.setMember, {
    handle: 'acme',
    login: 'bob',
    role: 'member',
  })
  const plan = (p: 'team' | 'business', seats = 3) =>
    t.mutation(internal.plans.setSubscription, {
      handle: 'acme',
      plan: p,
      status: 'active',
      seats,
    })
  return { t, as, alice, bob: as('bob'), plan }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as { code: string }).code
    throw e
  }
  return 'ok'
}

const page = { numItems: 50, cursor: null }

describe('the audit log', () => {
  test('is kept for every organization, and read on Business by owners and admins', async () => {
    const { alice, bob, plan } = await world()
    const read = (who: typeof alice) =>
      who.query(api.forge.audit.list, {
        org: 'acme',
        at: Date.now(),
        paginationOpts: page,
      })
    expect(await codeOf(read(alice))).toBe('plan_required')
    await plan('team')
    expect(await codeOf(read(alice))).toBe('plan_required')
    await plan('business')
    expect(await codeOf(read(bob))).toBe('forbidden')
    const log = await read(alice)
    expect(log.page.map((e) => e.action)).toEqual([
      'plan.changed',
      'plan.changed',
      'member.added',
      'organization.created',
    ])
    expect(log.page.find((e) => e.action === 'member.added')).toMatchObject({
      actor: 'alice',
      target: 'bob',
    })
  })

  test('records teams, repositories and their policies', async () => {
    const { alice, plan } = await world()
    await plan('business')
    await alice.mutation(api.forge.teams.create, { org: 'acme', slug: 'web' })
    await alice.mutation(api.forge.repos.create, {
      owner: 'acme',
      name: 'site',
      visibility: 'private',
    })
    await alice.mutation(api.forge.teams.setRepo, {
      org: 'acme',
      slug: 'web',
      owner: 'acme',
      name: 'site',
      permission: 'write',
    })
    await alice.mutation(api.forge.policy.setRuleMode, {
      owner: 'acme',
      name: 'site',
      rule: 'findings',
      mode: 'dry-run',
    })
    const log = await alice.query(api.forge.audit.list, {
      org: 'acme',
      at: Date.now(),
      paginationOpts: page,
    })
    expect(log.page.slice(0, 4).map((e) => [e.action, e.target])).toEqual([
      ['repo.policy_changed', 'acme/site'],
      ['team.repo_added', 'web'],
      ['repo.created', 'acme/site'],
      ['team.created', 'web'],
    ])
  })

  test('a person’s own repositories are not in any audit log', async () => {
    const { t, alice } = await world()
    await alice.mutation(api.forge.repos.create, {
      name: 'notes',
      visibility: 'private',
    })
    const all = await t.run((ctx) => ctx.db.query('auditEvents').collect())
    expect(all.some((e) => e.target === 'alice/notes')).toBe(false)
  })

  test('forgets events older than a year', async () => {
    const { t } = await world()
    setSystemTime(new Date(START + 400 * 86_400_000))
    await t.mutation(internal.forge.audit.sweep, {})
    expect(
      await t.run((ctx) => ctx.db.query('auditEvents').collect()),
    ).toHaveLength(0)
  })
})

describe('organization policies', () => {
  const rule = {
    org: 'acme',
    id: 'two-reviews',
    name: 'Two reviews on the API',
    kind: 'path_approval' as const,
    paths: ['api/**'],
    approvals: 2,
  }

  test('need Business, and an owner or admin', async () => {
    const { alice, bob, plan } = await world()
    expect(
      await codeOf(alice.mutation(api.forge.orgPolicy.setRule, rule)),
    ).toBe('plan_required')
    await plan('business')
    expect(await codeOf(bob.mutation(api.forge.orgPolicy.setRule, rule))).toBe(
      'forbidden',
    )
    const made = await alice.mutation(api.forge.orgPolicy.setRule, rule)
    expect(made).toMatchObject({ id: 'org.two-reviews', teams: [] })
    const seen = await bob.query(api.forge.orgPolicy.get, { org: 'acme' })
    expect(seen).toMatchObject({ business: true, canEdit: false })
    expect(seen.rules.map((r) => r.id)).toEqual(['org.two-reviews'])
  })

  test('join every repository’s rules, and a repository cannot weaken them', async () => {
    const { alice, plan } = await world()
    await plan('business')
    await alice.mutation(api.forge.repos.create, {
      owner: 'acme',
      name: 'site',
      visibility: 'private',
    })
    await alice.mutation(api.forge.orgPolicy.setRule, rule)
    const set = JSON.parse(
      await alice.query(api.forge.policy.get, {
        owner: 'acme',
        name: 'site',
        at: Date.now(),
      }),
    ) as { rules: Array<{ id: string; mode: string }> }
    expect(set.rules.find((r) => r.id === 'org.two-reviews')?.mode).toBe(
      'enforce',
    )
    const repo = { owner: 'acme', name: 'site', rule: 'org.two-reviews' }
    expect(
      await codeOf(
        alice.mutation(api.forge.policy.setRuleMode, { ...repo, mode: 'off' }),
      ),
    ).toBe('forbidden')
    expect(
      await codeOf(alice.mutation(api.forge.policy.deleteRule, repo)),
    ).toBe('forbidden')
    expect(
      await codeOf(
        alice.mutation(api.forge.policy.createRule, {
          owner: 'acme',
          name: 'site',
          id: 'org.mine',
          ruleName: 'Mine',
          kind: 'max_lines',
          max_lines: 10,
        }),
      ),
    ).toBe('invalid_request')
  })

  test('given to teams, bind only those teams’ repositories', async () => {
    const { alice, plan } = await world()
    await plan('business')
    await alice.mutation(api.forge.teams.create, { org: 'acme', slug: 'web' })
    for (const name of ['site', 'tools'])
      await alice.mutation(api.forge.repos.create, {
        owner: 'acme',
        name,
        visibility: 'private',
      })
    await alice.mutation(api.forge.teams.setRepo, {
      org: 'acme',
      slug: 'web',
      owner: 'acme',
      name: 'site',
      permission: 'write',
    })
    await alice.mutation(api.forge.orgPolicy.setRule, {
      ...rule,
      teams: ['web'],
    })
    const ids = async (name: string) =>
      (
        JSON.parse(
          await alice.query(api.forge.policy.get, {
            owner: 'acme',
            name,
            at: Date.now(),
          }),
        ) as { rules: Array<{ id: string }> }
      ).rules.map((r) => r.id)
    expect(await ids('site')).toContain('org.two-reviews')
    expect(await ids('tools')).not.toContain('org.two-reviews')
    expect(
      await codeOf(
        alice.mutation(api.forge.orgPolicy.setRule, {
          ...rule,
          teams: ['nobody'],
        }),
      ),
    ).toBe('invalid_request')
  })

  test('stop applying when the organization leaves Business, and come back with it', async () => {
    const { t, alice, plan } = await world()
    await plan('business')
    await alice.mutation(api.forge.repos.create, {
      owner: 'acme',
      name: 'site',
      visibility: 'private',
    })
    await alice.mutation(api.forge.orgPolicy.setRule, rule)
    await t.mutation(internal.plans.setSubscription, {
      handle: 'acme',
      plan: 'team',
      status: 'active',
    })
    const ids = async () =>
      (
        JSON.parse(
          await alice.query(api.forge.policy.get, {
            owner: 'acme',
            name: 'site',
            at: Date.now(),
          }),
        ) as { rules: Array<{ id: string }> }
      ).rules.map((r) => r.id)
    expect(await ids()).not.toContain('org.two-reviews')
    await plan('business')
    expect(await ids()).toContain('org.two-reviews')
  })
})
