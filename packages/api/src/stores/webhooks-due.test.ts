import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { convexTest } from 'convex-test'
import { api as forge } from '../../../../convex/_generated/api'
import schema from '../../../../convex/schema'
import { load } from '../../../../convex/seed'
import { claimsOf } from '../domain/convex'
import { createSampleApi } from '../index'
import { exportWorld } from '../seed-export'

process.env.API_JWT_ISSUER = 'https://convex.test'

const dir = new URL('../../../../convex/', import.meta.url).pathname
const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

const START = new Date('2026-11-08T12:00:00Z').getTime()
beforeEach(() => setSystemTime(new Date(START)))
afterEach(() => setSystemTime())

async function setup() {
  const sample = createSampleApi({})
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    load(ctx, exportWorld(sample.domain, sample.domain.svc.auth as never)),
  )
  return { t, asApi: t.withIdentity(claimsOf('system')) }
}

const nextDue = async (asApi: Awaited<ReturnType<typeof setup>>['asApi']) =>
  JSON.parse(await asApi.query(forge.forge.webhooks.nextDue, {})) as
    | number
    | null

test('nextDue: nothing pending, then the delivery, then its claim', async () => {
  const { t, asApi } = await setup()
  await t.run(async (ctx) => {
    for (const d of await ctx.db.query('webhookDeliveries').collect())
      await ctx.db.delete('webhookDeliveries', d._id)
  })
  expect(await nextDue(asApi)).toBeNull()

  const hook = JSON.parse(
    await asApi.mutation(forge.forge.webhooks.create, {
      full: 'dana/gitfs',
      url: 'https://example.com/hook',
      events: ['*'],
      secret: 'whsec_test_secret_000000',
    }),
  ) as { id: string }
  await asApi.mutation(forge.forge.webhooks.enqueueOne, {
    id: hook.id,
    event: JSON.stringify({ id: 'evt_1', type: 'webhook.ping' }),
    redeliveryOf: null,
  })
  expect(await nextDue(asApi)).toBeLessThanOrEqual(START)

  const claimed = JSON.parse(
    await asApi.mutation(forge.forge.webhooks.claim, { limit: 10 }),
  ) as Array<unknown>
  expect(claimed).toHaveLength(1)
  expect(await nextDue(asApi)).toBe(START + 60_000)
})

test('nextDue is the API server’s only', async () => {
  const { t } = await setup()
  await expect(t.query(forge.forge.webhooks.nextDue, {})).rejects.toThrow()
})

test('nextDue sees a new delivery behind more than 64 being sent', async () => {
  const { t, asApi } = await setup()
  await t.run(async (ctx) => {
    for (const d of await ctx.db.query('webhookDeliveries').collect())
      await ctx.db.delete('webhookDeliveries', d._id)
  })
  const hook = JSON.parse(
    await asApi.mutation(forge.forge.webhooks.create, {
      full: 'dana/gitfs',
      url: 'https://example.com/hook',
      events: ['*'],
      secret: 'whsec_test_secret_000000',
    }),
  ) as { id: string }
  const ping = (n: number) =>
    asApi.mutation(forge.forge.webhooks.enqueueOne, {
      id: hook.id,
      event: JSON.stringify({ id: `evt_${n}`, type: 'webhook.ping' }),
      redeliveryOf: null,
    })
  for (let n = 0; n < 100; n++) await ping(n)
  for (let n = 0; n < 2; n++)
    await asApi.mutation(forge.forge.webhooks.claim, { limit: 64 })
  expect(await nextDue(asApi)).toBe(START + 60_000)
  setSystemTime(new Date(START + 1_000))
  await ping(100)
  expect(await nextDue(asApi)).toBe(START + 1_000)
})
