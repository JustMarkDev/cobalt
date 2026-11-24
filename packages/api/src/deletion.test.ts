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
import { api, components, internal } from '../../../convex/_generated/api'
import { GHOST, TABLES, ghostJson, retiredHash } from '../../../convex/deletion'
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

const DAY = 86_400_000
const START = Date.parse('2026-11-21T12:00:00Z')

beforeEach(() => setSystemTime(new Date(START)))
afterEach(() => setSystemTime())

async function world() {
  const t = convexTest(schema, modules)
  t.registerComponent('betterAuth', betterAuth.schema, betterAuth.modules)
  const person = (handle: string, authId: string) =>
    t.run((ctx) =>
      ctx.db.insert('accounts', {
        kind: 'person',
        handle,
        name: handle,
        bio: '',
        authId,
        publicId: `acc_${handle}`,
        created: START,
        updated: START,
        version: 1,
        aclRev: 0,
      }),
    )
  const alice = await person('alice', 'user_alice')
  const bob = await person('bob', 'user_bob')
  const as = (authId: string) =>
    t.withIdentity({
      subject: authId,
      email: `${authId.replace('user_', '')}@mail.test`,
      name: authId.replace('user_', ''),
    })
  return { t, alice, bob, as }
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

async function settle(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 0))
    await t.finishInProgressScheduledFunctions()
    const at = Date.now()
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).some(
        (j) =>
          j.state.kind === 'inProgress' ||
          (j.state.kind === 'pending' && j.scheduledTime <= at),
      ),
    )
    if (!pending) return
  }
  throw new Error('scheduled work did not finish')
}

describe('the Free plan', () => {
  test('public repositories are open to everyone; private ones need a paid plan', async () => {
    const { as } = await world()
    const alice = as('user_alice')
    expect(
      await codeOf(
        alice.mutation(api.forge.repos.create, {
          name: 'open',
          visibility: 'public',
        }),
      ),
    ).toBe('ok')
    expect(
      await codeOf(
        alice.mutation(api.forge.repos.create, {
          name: 'closed',
          visibility: 'private',
        }),
      ),
    ).toBe('plan_required')
  })

  test('a grant opens private repositories for a while, and only for that account', async () => {
    const { t, as } = await world()
    await t.mutation(internal.plans.grant, {
      handle: 'alice',
      plan: 'business',
      days: 60,
      reason: 'Trying it',
    })
    expect(
      await codeOf(
        as('user_alice').mutation(api.forge.repos.create, {
          name: 'closed',
          visibility: 'private',
        }),
      ),
    ).toBe('ok')
    expect(
      await codeOf(
        as('user_bob').mutation(api.forge.repos.create, {
          name: 'closed',
          visibility: 'private',
        }),
      ),
    ).toBe('plan_required')
    const mine = JSON.parse(await as('user_alice').query(api.plans.mine, {}))
    expect(mine).toMatchObject({ plan: 'business', source: 'grant' })
    expect(mine.until).toBe(START + 60 * DAY)
  })

  test('a grant is a loan: it has an end, and an operator can end it sooner', async () => {
    const { t } = await world()
    await expect(
      t.mutation(internal.plans.grant, {
        handle: 'alice',
        plan: 'solo',
        days: 400,
        reason: 'Too long',
      }),
    ).rejects.toThrow()
    await expect(
      t.mutation(internal.plans.grant, {
        handle: 'alice',
        plan: 'solo',
        days: 5,
        reason: '  ',
      }),
    ).rejects.toThrow()
    await t.mutation(internal.plans.grant, {
      handle: 'alice',
      plan: 'solo',
      days: 5,
      reason: 'A week',
    })
    expect(
      await t.mutation(internal.plans.revokeGrants, { handle: 'alice' }),
    ).toEqual({ handle: 'alice', revoked: 1 })
    const list = await t.query(internal.plans.grants, { handle: 'alice' })
    expect(list).toHaveLength(1)
    expect(list[0].live).toBe(false)
  })

  test('when a grant ends, a private repository still reads and clones, and stops taking writes', async () => {
    const { t, as } = await world()
    await t.mutation(internal.plans.grant, {
      handle: 'alice',
      plan: 'solo',
      days: 30,
      reason: 'Try',
    })
    const alice = as('user_alice')
    await alice.mutation(api.forge.repos.create, {
      name: 'closed',
      visibility: 'private',
    })
    const access = (need: 'read' | 'write') =>
      alice.query(api.forge.repos.access, {
        owner: 'alice',
        name: 'closed',
        need,
        strict: false,
      })
    expect(await codeOf(access('write'))).toBe('ok')
    setSystemTime(new Date(START + 31 * DAY))
    expect(await codeOf(access('read'))).toBe('ok')
    expect(await codeOf(access('write'))).toBe('read_only')
    expect(
      await codeOf(
        alice.mutation(api.forge.repos.update, {
          owner: 'alice',
          name: 'closed',
          body: { visibility: 'public' },
        }),
      ),
    ).toBe('ok')
    expect(await codeOf(access('write'))).toBe('ok')
  })

  test('a subscription that ended leaves Free, with the date history is kept until', async () => {
    const { t, as } = await world()
    await t.mutation(internal.plans.setSubscription, {
      handle: 'alice',
      plan: 'solo',
      status: 'active',
    })
    expect(
      JSON.parse(await as('user_alice').query(api.plans.mine, {})).plan,
    ).toBe('solo')
    await t.mutation(internal.plans.setSubscription, {
      handle: 'alice',
      plan: 'solo',
      status: 'lapsed',
    })
    const mine = JSON.parse(await as('user_alice').query(api.plans.mine, {}))
    expect(mine).toMatchObject({ plan: 'free', source: 'free' })
    expect(mine.keptUntil).toBe(START + 90 * DAY)
  })
})

describe('asking to be deleted', () => {
  const ask = (w: Awaited<ReturnType<typeof world>>, confirm = 'alice') =>
    w.as('user_alice').mutation(api.deletion.request, { confirm })

  test('needs the address typed, and starts 30 days', async () => {
    const w = await world()
    expect(await codeOf(ask(w, 'alicia'))).toBe('invalid_request')
    expect(await codeOf(ask(w))).toBe('ok')
    const mine = JSON.parse(await w.as('user_alice').query(api.plans.mine, {}))
    expect(mine.deletion).toEqual({
      requested: START,
      purgeAt: START + 30 * DAY,
    })
  })

  test('a token cannot ask: only the signed-in site', async () => {
    const { t } = await world()
    const viaToken = t.withIdentity({
      issuer: 'https://convex.test',
      subject: 'alice',
      cb_api: 'true',
      cb_scp: 'repo:read repo:write',
    })
    expect(
      await codeOf(
        viaToken.mutation(api.deletion.request, { confirm: 'alice' }),
      ),
    ).toBe('forbidden')
  })

  test('the account only reads while it waits, and taking it back undoes that', async () => {
    const w = await world()
    const alice = w.as('user_alice')
    await alice.mutation(api.forge.repos.create, {
      name: 'open',
      visibility: 'public',
    })
    await ask(w)
    const write = () =>
      alice.query(api.forge.repos.access, {
        owner: 'alice',
        name: 'open',
        need: 'write',
        strict: false,
      })
    expect(await codeOf(write())).toBe('read_only')
    expect(
      await codeOf(
        alice.mutation(api.forge.repos.create, {
          name: 'another',
          visibility: 'public',
        }),
      ),
    ).toBe('read_only')
    await alice.mutation(api.deletion.cancel, {})
    expect(await codeOf(write())).toBe('ok')
    expect(
      JSON.parse(await alice.query(api.plans.mine, {})).deletion,
    ).toBeNull()
  })

  test('an organization with only this owner has to be handed over first', async () => {
    const w = await world()
    await w.t.run(async (ctx) => {
      const org = await ctx.db.insert('accounts', {
        kind: 'organization',
        handle: 'acme',
        name: 'Acme',
        bio: '',
        publicId: 'acc_acme',
        created: START,
        updated: START,
        version: 1,
        aclRev: 0,
      })
      await ctx.db.insert('memberships', {
        organizationId: org,
        personId: w.alice,
        role: 'owner',
      })
    })
    expect(await codeOf(ask(w))).toBe('invalid_state')
    await w.t.run((ctx) =>
      ctx.db
        .query('accounts')
        .withIndex('by_handle', (q) => q.eq('handle', 'acme'))
        .unique()
        .then((org) =>
          ctx.db.insert('memberships', {
            organizationId: org!._id,
            personId: w.bob,
            role: 'owner',
          }),
        ),
    )
    expect(await codeOf(ask(w))).toBe('ok')
  })

  test('nothing is erased before the 30 days are over', async () => {
    const w = await world()
    await ask(w)
    setSystemTime(new Date(START + 29 * DAY))
    await w.t.mutation(internal.deletion.purgeDue, {})
    await settle(w.t)
    expect(
      await w.t.run((ctx) => ctx.db.get('accounts', w.alice)),
    ).not.toBeNull()
  })
})

describe('the erasure', () => {
  async function erased() {
    const w = await world()
    const { t, as } = w
    const alice = as('user_alice')
    const bobs = as('user_bob')
    await alice.mutation(api.forge.repos.create, {
      name: 'mine',
      visibility: 'public',
    })
    await bobs.mutation(api.forge.repos.create, {
      name: 'theirs',
      visibility: 'public',
    })
    const bobRepo = await t.run(async (ctx) =>
      ctx.db
        .query('repos')
        .withIndex('by_key', (q) => q.eq('key', 'bob/theirs'))
        .unique(),
    )
    await t.run(async (ctx) => {
      await ctx.db.insert('issues', {
        repoId: bobRepo!._id,
        publicId: 'iss_1',
        number: 1,
        title: 'A bug',
        body: 'It breaks.',
        text: 'A bug It breaks.',
        state: 'open',
        author: { id: 'acc_alice', handle: 'alice' },
        labels: [],
        assignees: [{ id: 'acc_alice', handle: 'alice' }],
        commentCount: 0,
        created: START,
        updated: START,
        closed: null,
        version: 1,
      })
      await ctx.db.insert('follows', { who: 'alice', whom: 'bob' })
      await ctx.db.insert('follows', { who: 'bob', whom: 'alice' })
      await ctx.db.insert('stars', {
        repoId: bobRepo!._id,
        handle: 'alice',
        at: START,
      })
      await ctx.db.insert('accountPrefs', { handle: 'alice', prefs: '{}' })
      await ctx.db.insert('uploads', {
        publicId: 'upl_alice1',
        owner: 'alice',
        filename: 'screen.png',
        contentType: 'image/png',
        size: 10,
        purpose: 'evidence',
        state: 'uploaded',
        sha256: null,
        expires: START + DAY,
        created: START,
        attachedTo: null,
        attachedRepoId: null,
      })
    })
    const user = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'Alice',
          email: 'alice@example.com',
          emailVerified: true,
          createdAt: START,
          updatedAt: START,
          username: 'alice',
        },
      },
    })) as { _id: string }
    await t.run((ctx) =>
      ctx.db.patch('accounts', w.alice, { authId: user._id }),
    )
    await t
      .withIdentity({ subject: user._id })
      .mutation(api.deletion.request, { confirm: 'alice' })
    setSystemTime(new Date(START + 31 * DAY))
    await t.mutation(internal.deletion.purgeDue, {})
    await settle(t)
    return w
  }

  test('the account and what it owned are gone', async () => {
    const { t, alice } = await erased()
    await t.run(async (ctx) => {
      expect(await ctx.db.get('accounts', alice)).toBeNull()
      const left = await ctx.db
        .query('repos')
        .withIndex('by_key', (q) => q.eq('key', 'alice/mine'))
        .unique()
      expect(left).toBeNull()
      expect(
        await ctx.db
          .query('follows')
          .withIndex('by_who_and_whom', (q) => q.eq('who', 'alice'))
          .take(5),
      ).toEqual([])
      expect(
        await ctx.db
          .query('follows')
          .withIndex('by_whom_and_who', (q) => q.eq('whom', 'alice'))
          .take(5),
      ).toEqual([])
      expect(
        await ctx.db
          .query('stars')
          .withIndex('by_handle', (q) => q.eq('handle', 'alice'))
          .take(5),
      ).toEqual([])
      expect(
        await ctx.db
          .query('accountPrefs')
          .withIndex('by_handle', (q) => q.eq('handle', 'alice'))
          .take(5),
      ).toEqual([])
    })
  })

  test('what she wrote in someone else’s repository stays, under the ghost', async () => {
    const { t } = await erased()
    const issue = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_publicId', (q) => q.eq('publicId', 'iss_1'))
        .unique(),
    )
    expect(issue!.title).toBe('A bug')
    expect(issue!.author).toEqual(GHOST)
    expect(issue!.assignees).toEqual([GHOST])
  })

  test('bob is untouched', async () => {
    const { t, bob } = await erased()
    await t.run(async (ctx) => {
      expect((await ctx.db.get('accounts', bob))?.handle).toBe('bob')
      expect(
        await ctx.db
          .query('repos')
          .withIndex('by_key', (q) => q.eq('key', 'bob/theirs'))
          .unique(),
      ).not.toBeNull()
    })
  })

  test('the address stays taken, as a hash and nothing else', async () => {
    const { t } = await erased()
    const holder = await t.query(internal.accounts.handleHolder, {
      handle: 'alice',
    })
    expect(holder).not.toBeNull()
    expect(holder?.authId).toBe('retired')
    const rows = await t.run((ctx) => ctx.db.query('retiredHandles').collect())
    expect(rows.map((r) => r.hash)).toEqual([retiredHash('alice')])
    expect(JSON.stringify(rows)).not.toContain('alice')
  })

  test('her git store and her files are queued for deletion, by opaque id only', async () => {
    const { t } = await erased()
    const rows = await t.run((ctx) => ctx.db.query('sweeps').collect())
    expect(rows.map((r) => r.kind).sort()).toEqual(['blob', 'git'])
    expect(rows.find((r) => r.kind === 'blob')?.key).toBe('upl_alice1')
    expect(JSON.stringify(rows)).not.toContain('alice/')
  })

  test('the sign-in user goes too', async () => {
    const { t } = await erased()
    const user = await t.query(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', operator: 'eq', value: 'alice@example.com' }],
    })
    expect(user).toBeNull()
  })
})

describe('what the code knows about every table', () => {
  test('each table is classified, and nothing stale is', () => {
    const tables = Object.keys(schema.tables).sort()
    expect(Object.keys(TABLES).sort()).toEqual(tables)
  })
})

describe('rewriting a name in JSON', () => {
  test('every object naming the person names the ghost, and nothing else changes', () => {
    const text = JSON.stringify({
      author: { id: 'acc_alice', handle: 'alice' },
      replies: [{ by: { id: 'acc_bob', handle: 'bob' }, body: 'hi alice' }],
    })
    const next = JSON.parse(ghostJson(text, 'alice', 'acc_alice')!)
    expect(next.author).toEqual(GHOST)
    expect(next.replies[0].by.handle).toBe('bob')
    expect(next.replies[0].body).toBe('hi alice')
  })

  test('JSON that does not name her is left alone', () => {
    expect(ghostJson('{"a":1}', 'alice', 'acc_alice')).toBeNull()
    expect(ghostJson('not json', 'alice', 'acc_alice')).toBeNull()
  })
})

const SECRET = 'worker-secret-0123456789'

describe('the store worker', () => {
  beforeEach(() => {
    process.env.API_STORE_SECRET = SECRET
  })

  async function withRepo() {
    const w = await world()
    await w.as('user_alice').mutation(api.forge.repos.create, {
      name: 'mine',
      visibility: 'public',
    })
    const repo = await w.t.run((ctx) =>
      ctx.db
        .query('repos')
        .withIndex('by_key', (q) => q.eq('key', 'alice/mine'))
        .unique(),
    )
    return { ...w, repo: repo! }
  }

  test('refuses anyone without the secret', async () => {
    const { t } = await world()
    await expect(
      t.mutation(api.storeWorker.claim, {
        secret: 'nope-nope-nope-nope',
        kinds: ['git'],
        measure: true,
        max: 10,
      }),
    ).rejects.toThrow()
  })

  test('a queued deletion is leased to one worker, and leaves the queue when done', async () => {
    const { t } = await world()
    await t.run((ctx) =>
      ctx.db.insert('sweeps', {
        kind: 'git',
        key: 'store_1',
        created: START,
        lease: 0,
      }),
    )
    const claim = () =>
      t.mutation(api.storeWorker.claim, {
        secret: SECRET,
        kinds: ['git', 'blob'],
        measure: false,
        max: 10,
      })
    const first = await claim()
    expect(first.sweeps.map((s) => s.key)).toEqual(['store_1'])
    expect((await claim()).sweeps).toEqual([])
    await t.mutation(api.storeWorker.done, {
      secret: SECRET,
      ids: first.sweeps.map((s) => s.id),
    })
    expect(await t.run((ctx) => ctx.db.query('sweeps').collect())).toEqual([])
  })

  test('a worker that cannot delete a kind is not handed it', async () => {
    const { t } = await world()
    await t.run((ctx) =>
      ctx.db.insert('sweeps', {
        kind: 'git',
        key: 'store_1',
        created: START,
        lease: 0,
      }),
    )
    const got = await t.mutation(api.storeWorker.claim, {
      secret: SECRET,
      kinds: ['blob'],
      measure: false,
      max: 10,
    })
    expect(got.sweeps).toEqual([])
  })

  test('a push marks the repository for measuring, and the size lands in Plan and data', async () => {
    const { t, as, repo } = await withRepo()
    await t.mutation(internal.forge.pushes.recordPush, {
      storeId: repo.storeId,
      ref: 'refs/heads/main',
      before: '0'.repeat(40),
      after: 'a'.repeat(40),
      pushedAt: START,
    })
    const got = await t.mutation(api.storeWorker.claim, {
      secret: SECRET,
      kinds: [],
      measure: true,
      max: 10,
    })
    expect(got.measure).toEqual([repo.storeId])
    await t.mutation(api.storeWorker.reportSize, {
      secret: SECRET,
      storeId: repo.storeId,
      bytes: 40_000_000,
    })
    const none = await t.mutation(api.storeWorker.claim, {
      secret: SECRET,
      kinds: [],
      measure: true,
      max: 10,
    })
    expect(none.measure).toEqual([])
    const mine = JSON.parse(await as('user_alice').query(api.plans.mine, {}))
    expect(mine.usage).toMatchObject({
      storageBytes: 40_000_000,
      quota: null,
    })
  })

  test('on Free, going past storage pauses pushes only; a paid plan is never paused', async () => {
    const { t, as, repo } = await withRepo()
    const alice = as('user_alice')
    const publish = (tag: string) =>
      codeOf(
        alice.mutation(api.forge.releases.create, {
          owner: 'alice',
          name: 'mine',
          tag,
          channel: 'stable',
          title: tag,
          assets: [],
        }),
      )
    expect(await publish('v1')).toBe('ok')
    await t.mutation(api.storeWorker.reportSize, {
      secret: SECRET,
      storeId: repo.storeId,
      bytes: 300_000_000,
    })
    expect(await publish('v2')).toBe('read_only')
    expect(
      await codeOf(
        alice.query(api.forge.repos.access, {
          owner: 'alice',
          name: 'mine',
          need: 'write',
          strict: false,
        }),
      ),
    ).toBe('ok')
    expect(JSON.parse(await alice.query(api.plans.mine, {})).usage.quota).toBe(
      'storage',
    )
    await t.mutation(internal.plans.setSubscription, {
      handle: 'alice',
      plan: 'solo',
      status: 'active',
    })
    expect(await publish('v3')).toBe('ok')
  })

  test('transfer out counts for the owner this month, and a new month starts at zero', async () => {
    const { t, as, repo } = await withRepo()
    await t.mutation(api.storeWorker.addTransfer, {
      secret: SECRET,
      storeId: repo.storeId,
      bytes: 600_000_000,
    })
    await t.mutation(api.storeWorker.addTransfer, {
      secret: SECRET,
      storeId: repo.storeId,
      bytes: 600_000_000,
    })
    const alice = as('user_alice')
    let usage = JSON.parse(await alice.query(api.plans.mine, {})).usage
    expect(usage).toMatchObject({
      transferBytes: 1_200_000_000,
      quota: 'transfer',
    })
    setSystemTime(new Date(START + 40 * DAY))
    usage = JSON.parse(await alice.query(api.plans.mine, {})).usage
    expect(usage).toMatchObject({ transferBytes: 0, quota: null })
  })

  test('the size of a repository that is gone is forgotten', async () => {
    const { t, repo } = await withRepo()
    await t.mutation(api.storeWorker.reportSize, {
      secret: SECRET,
      storeId: repo.storeId,
      bytes: 5,
    })
    await t.mutation(api.storeWorker.reportSize, {
      secret: SECRET,
      storeId: 'store_that_was_deleted',
      bytes: 5,
    })
    expect(
      (await t.run((ctx) => ctx.db.query('repoSizes').collect())).length,
    ).toBe(1)
  })
})

describe('Polar tells us about a subscription', () => {
  const POLAR = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`

  async function signedPost(
    t: ReturnType<typeof convexTest>,
    event: unknown,
    secret = POLAR,
  ) {
    const body = JSON.stringify(event)
    const id = 'msg_1'
    const ts = String(Math.floor(Date.now() / 1000))
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${id}.${ts}.${body}`),
      ),
    )
    return t.fetch('/hooks/polar', {
      method: 'POST',
      headers: {
        'webhook-id': id,
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
      },
      body,
    })
  }

  const event = (type: string, data: Record<string, unknown>, at = START) => ({
    type,
    timestamp: new Date(at).toISOString(),
    data: {
      id: 'sub_1',
      status: 'active',
      current_period_end: new Date(START + 30 * DAY).toISOString(),
      metadata: { account: 'alice', plan: 'team' },
      ...data,
    },
  })

  beforeEach(() => {
    process.env.POLAR_WEBHOOK_SECRET = POLAR
  })

  test('a signed event makes the account paid, and a revoked one ends it', async () => {
    const { t, as } = await world()
    expect((await signedPost(t, event('subscription.active', {}))).status).toBe(
      200,
    )
    expect(
      JSON.parse(await as('user_alice').query(api.plans.mine, {})),
    ).toMatchObject({ plan: 'team', source: 'subscription' })
    expect(
      (
        await signedPost(
          t,
          event(
            'subscription.revoked',
            { status: 'canceled', ended_at: new Date(START).toISOString() },
            START + 1000,
          ),
        )
      ).status,
    ).toBe(200)
    expect(
      JSON.parse(await as('user_alice').query(api.plans.mine, {})),
    ).toMatchObject({ plan: 'free' })
  })

  test('an event that arrives late does not undo a newer one', async () => {
    const { t, as } = await world()
    await signedPost(t, event('subscription.active', {}, START + 5000))
    await signedPost(
      t,
      event(
        'subscription.revoked',
        { status: 'canceled', ended_at: 'x' },
        START,
      ),
    )
    expect(
      JSON.parse(await as('user_alice').query(api.plans.mine, {})).plan,
    ).toBe('team')
  })

  test('refuses a wrong signature, and shrugs at an account that does not exist', async () => {
    const { t } = await world()
    expect(
      (
        await signedPost(
          t,
          event('subscription.active', {}),
          `whsec_${btoa('another-secret-0123456789abcdef')}`,
        )
      ).status,
    ).toBe(401)
    const unknown = event('subscription.active', {
      metadata: { account: 'nobody', plan: 'team' },
    })
    expect((await signedPost(t, unknown)).status).toBe(202)
  })
})

describe('asking PostHog to forget', () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
    delete process.env.POSTHOG_PERSONAL_KEY
    delete process.env.POSTHOG_PROJECT_ID
    delete process.env.POSTHOG_HOST
  })

  test('sends the address, with events, to the project; EU ingest maps to the EU API', async () => {
    process.env.POSTHOG_PERSONAL_KEY = 'phx_secret'
    process.env.POSTHOG_PROJECT_ID = '123'
    process.env.POSTHOG_HOST = 'https://eu.i.posthog.com'
    const seen: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = ((url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
    const { t } = await world()
    await t.action(internal.deletion.erasePostHog, {
      handle: 'alice',
      attempt: 1,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(
      'https://eu.posthog.com/api/projects/123/persons/bulk_delete/',
    )
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer phx_secret',
    )
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      distinct_ids: ['alice'],
      delete_events: true,
      delete_recordings: true,
    })
  })

  test('a refusal is tried again later, not lost', async () => {
    process.env.POSTHOG_PERSONAL_KEY = 'phx_secret'
    process.env.POSTHOG_PROJECT_ID = '123'
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('no', { status: 503 }),
      )) as unknown as typeof fetch
    const { t } = await world()
    await t.action(internal.deletion.erasePostHog, {
      handle: 'alice',
      attempt: 1,
    })
    const jobs = await t.run((ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    )
    expect(jobs.some((j) => j.state.kind === 'pending')).toBe(true)
  })
})

describe('paying for a plan', () => {
  const real = globalThis.fetch
  type Call = { url: string; auth: string | null; body: unknown }
  let calls: Array<Call>

  beforeEach(() => {
    calls = []
    process.env.POLAR_ACCESS_TOKEN = 'polar_oat_secret'
    process.env.SITE_URL = 'https://example.test'
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(init?.body as string),
      })
      return Promise.resolve(
        Response.json({
          url: 'https://polar.sh/checkout/c_1',
          customer_portal_url: 'https://polar.sh/portal/p_1',
        }),
      )
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = real
    delete process.env.POLAR_ACCESS_TOKEN
  })

  test('opens a checkout with the plan, the paying address and the currency', async () => {
    const { as } = await world()
    const url = await as('user_alice').action(api.billing.checkout, {
      plan: 'team',
      cycle: 'year',
      seats: 3,
      currency: 'eur',
    })
    expect(url).toBe('https://polar.sh/checkout/c_1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.polar.sh/v1/checkouts/')
    expect(calls[0].auth).toBe('Bearer polar_oat_secret')
    expect(calls[0].body).toMatchObject({
      products: ['8ffab6ad-9379-4480-abed-4cfaa9f1a86f'],
      metadata: { account: 'alice', plan: 'team' },
      customer_email: 'alice@mail.test',
      seats: 3,
      currency: 'eur',
      success_url: 'https://example.test/settings/plan?billing=done',
    })
  })

  test('when Polar refuses the email, the checkout asks for it instead of failing', async () => {
    const { as } = await world()
    const answer = globalThis.fetch
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      if ('customer_email' in body) {
        calls.push({ url: String(url), auth: null, body })
        return Promise.resolve(
          Response.json(
            {
              detail: [
                { loc: ['body', 'customer_email'], type: 'value_error' },
              ],
            },
            { status: 422 },
          ),
        )
      }
      return (
        answer as (u: string | URL, i?: RequestInit) => Promise<Response>
      )(url, init)
    }) as unknown as typeof fetch
    const url = await as('user_alice').action(api.billing.checkout, {
      plan: 'solo',
      cycle: 'month',
    })
    expect(url).toBe('https://polar.sh/checkout/c_1')
    expect(calls).toHaveLength(2)
    expect(calls[1].body).not.toHaveProperty('customer_email')
  })

  test('a plan for one person has no seats', async () => {
    const { as } = await world()
    await as('user_alice').action(api.billing.checkout, {
      plan: 'solo',
      cycle: 'month',
    })
    expect(calls[0].body).not.toHaveProperty('seats')
  })

  test('only the signed-in owner can pay for an account', async () => {
    const { as } = await world()
    expect(
      await codeOf(
        as('user_bob').action(api.billing.checkout, {
          plan: 'solo',
          cycle: 'month',
          account: 'alice',
        }),
      ),
    ).toBe('forbidden')
    expect(
      await codeOf(
        convexTest(schema, modules).action(api.billing.checkout, {
          plan: 'solo',
          cycle: 'month',
        }),
      ),
    ).toBe('unauthenticated')
    expect(calls).toHaveLength(0)
  })

  test('an account that already pays is sent to its billing page, not a second checkout', async () => {
    const { t, as } = await world()
    await t.mutation(internal.plans.setSubscription, {
      handle: 'alice',
      plan: 'solo',
      status: 'active',
    })
    expect(
      await codeOf(
        as('user_alice').action(api.billing.checkout, {
          plan: 'team',
          cycle: 'month',
        }),
      ),
    ).toBe('conflict')
    expect(await as('user_alice').action(api.billing.portal, {})).toBe(
      'https://polar.sh/portal/p_1',
    )
    expect(calls[0].url).toBe('https://api.polar.sh/v1/customer-sessions/')
  })

  test('there is no billing page for an account that pays nothing', async () => {
    const { as } = await world()
    expect(await codeOf(as('user_alice').action(api.billing.portal, {}))).toBe(
      'not_found',
    )
  })

  test('without a token it says it is not set up, and sends nothing', async () => {
    const { as } = await world()
    delete process.env.POLAR_ACCESS_TOKEN
    expect(
      await codeOf(
        as('user_alice').action(api.billing.checkout, {
          plan: 'solo',
          cycle: 'month',
        }),
      ),
    ).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })
})
