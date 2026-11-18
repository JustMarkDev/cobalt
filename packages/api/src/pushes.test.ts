import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { convexTest } from 'convex-test'
import schema from '../../../convex/schema'
import { load } from '../../../convex/seed'
import { createSampleApi } from './index'
import { exportWorld } from './seed-export'

// convex-test's issuer: Convex trusts the API's JWT only from its own issuer.
process.env.API_JWT_ISSUER = 'https://convex.test'

/** code.storage telling us about a push: checked, recorded once, a patch set for an open change. */
const dir = new URL('../../../convex/', import.meta.url).pathname
const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

const SECRET = 'whsec_test_0123456789abcdef'

beforeEach(() => setSystemTime(new Date('2026-11-08T12:00:00Z')))
afterEach(() => setSystemTime())

async function setup() {
  process.env.CODE_STORAGE_WEBHOOK_SECRET = SECRET
  const sample = createSampleApi({})
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    load(ctx, exportWorld(sample.domain, sample.domain.svc.auth as never)),
  )
  const repo = sample.domain.repos.get('dana/gitfs')!
  const change = [...repo.changes.values()].find((c) => c.state === 'open')!
  return { t, storeId: repo.storeId, change }
}

const signed = (
  body: string,
  at = Math.floor(Date.now() / 1000),
  secret = SECRET,
) =>
  `t=${at},sha256=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`

const push = (storeId: string, ref: string, after: string) =>
  JSON.stringify({
    repository: { id: storeId, url: 'https://git.code.storage/x' },
    ref,
    before: '1'.repeat(40),
    after,
    customer_id: 'cus_1',
    pushed_at: new Date().toISOString(),
  })

test('a signed push to an open change branch is its next patch set, once', async () => {
  const { t, storeId, change } = await setup()
  const body = push(storeId, `refs/heads/${change.branch}`, 'a'.repeat(40))
  const send = () =>
    t.fetch('/hooks/code-storage', {
      method: 'POST',
      headers: { 'x-pierre-signature': signed(body), 'x-pierre-event': 'push' },
      body,
    })
  const first = await send()
  expect(first.status).toBe(200)
  expect(await first.text()).toBe('patch_set_added')
  // The same webhook again: recorded once.
  expect(await (await send()).text()).toBe('duplicate')
  const sets = await t.run(async (ctx) => {
    const c = await ctx.db
      .query('changes')
      .withIndex('by_publicId', (q) => q.eq('publicId', change.id))
      .unique()
    return c!.headSha
  })
  expect(sets).toBe('a'.repeat(40))
})

test('a wrong, missing or stale signature is refused', async () => {
  const { t, storeId } = await setup()
  const body = push(storeId, 'refs/heads/main', 'b'.repeat(40))
  const post = (signature?: string) =>
    t.fetch('/hooks/code-storage', {
      method: 'POST',
      headers: {
        'x-pierre-event': 'push',
        ...(signature ? { 'x-pierre-signature': signature } : {}),
      },
      body,
    })
  expect((await post()).status).toBe(401)
  expect(
    (await post(signed(body, undefined, 'whsec_someone_else_000000'))).status,
  ).toBe(401)
  expect(
    (await post(signed(body, Math.floor(Date.now() / 1000) - 600))).status,
  ).toBe(401)
  expect((await post(signed(body))).status).toBe(200)
})

test('a push keeps a receipt: git push, and the model its commit declares', async () => {
  const { t, storeId, change } = await setup()
  const body = JSON.stringify({
    ...JSON.parse(push(storeId, `refs/heads/${change.branch}`, 'c'.repeat(40))),
    head_commit: {
      message:
        'Fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n',
    },
  })
  const res = await t.fetch('/hooks/code-storage', {
    method: 'POST',
    headers: { 'x-pierre-signature': signed(body), 'x-pierre-event': 'push' },
    body,
  })
  expect(await res.text()).toBe('patch_set_added')
  const via = await t.run(async (ctx) => {
    const repo = (await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', storeId))
      .unique())!
    const doc = (await ctx.db
      .query('changes')
      .withIndex('by_repoId_and_number', (q) =>
        q.eq('repoId', repo._id).eq('number', change.number),
      )
      .unique())!
    const parts = await ctx.db
      .query('changeParts')
      .withIndex('by_changeId_and_kind_and_seq', (q) =>
        q.eq('changeId', doc._id).eq('kind', 'patchSet'),
      )
      .take(100)
    return (JSON.parse(parts.at(-1)!.json) as { via?: unknown }).via
  })
  expect(via).toEqual({
    machine: null,
    tool: 'git push',
    model: 'Claude Opus 5.5',
  })
})

test('a push declaring a declined model moves the branch, not the change', async () => {
  const { t, storeId, change } = await setup()
  await t.run(async (ctx) => {
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', storeId))
      .unique()
    await ctx.db.patch('repos', repo!._id, {
      declinedModels: ['Claude Haiku 5.5'],
    })
  })
  const body = JSON.stringify({
    ...JSON.parse(push(storeId, `refs/heads/${change.branch}`, 'c'.repeat(40))),
    head_commit: {
      message: 'Fix it\n\nAssisted-by: claude-code:claude haiku 5.5',
    },
  })
  const res = await t.fetch('/hooks/code-storage', {
    method: 'POST',
    headers: { 'x-pierre-signature': signed(body), 'x-pierre-event': 'push' },
    body,
  })
  expect(await res.text()).toBe('model_declined')
  const head = await t.run(async (ctx) => {
    const c = await ctx.db
      .query('changes')
      .withIndex('by_publicId', (q) => q.eq('publicId', change.id))
      .unique()
    return c!.headSha
  })
  expect(head).not.toBe('c'.repeat(40))
})

test('a push to a change whose author is denounced does not become a patch set', async () => {
  const { t, storeId, change } = await setup()
  await t.run(async (ctx) => {
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', storeId))
      .unique()
    const c = await ctx.db
      .query('changes')
      .withIndex('by_publicId', (q) => q.eq('publicId', change.id))
      .unique()
    const author = c!.author.handle
    await ctx.db.patch('repos', repo!._id, {
      denounced: [{ handle: author, reason: 'testing' }],
    })
  })
  const body = push(storeId, `refs/heads/${change.branch}`, 'd'.repeat(40))
  const res = await t.fetch('/hooks/code-storage', {
    method: 'POST',
    headers: { 'x-pierre-signature': signed(body), 'x-pierre-event': 'push' },
    body,
  })
  expect(await res.text()).toBe('denounced')
})
