import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { convexTest } from 'convex-test'
import { internal } from '../../../convex/_generated/api'
import { queueMail } from '../../../convex/mail'
import schema from '../../../convex/schema'

const dir = new URL('../../../convex/', import.meta.url).pathname
const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

const realFetch = globalThis.fetch
const g = globalThis as { __cbMailSink?: unknown }
const sink = g.__cbMailSink

type Call = { key: string | null }
let calls: Array<Call>
let answers: Array<number | 'down'>

beforeEach(() => {
  jest.useFakeTimers()
  process.env.RESEND_API_KEY = 're_test'
  process.env.MAIL_FROM = 'cobalt <no-reply@cobaltforge.dev>'
  delete g.__cbMailSink
  calls = []
  answers = [200]
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    calls.push({ key: new Headers(init.headers).get('idempotency-key') })
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (a === 'down') return Promise.reject(new TypeError('network down'))
    return Promise.resolve(
      new Response(a === 200 ? '{"id":"x"}' : 'nope', { status: a }),
    )
  }) as typeof fetch
})

afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = realFetch
  g.__cbMailSink = sink
  delete process.env.RESEND_API_KEY
  delete process.env.MAIL_FROM
})

type T = Awaited<ReturnType<typeof queued>>

async function queued() {
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    queueMail(ctx, { to: 'a@example.com', subject: 's', text: 'hi' }),
  )
  return t
}

const drain = (t: T) => t.finishAllScheduledFunctions(jest.runAllTimers)
const left = (t: T) => t.run((ctx) => ctx.db.query('outbox').collect())

describe('outbox', () => {
  test('a sent message leaves the outbox, under a key that is its own', async () => {
    const t = await queued()
    await drain(t)
    expect(calls).toHaveLength(1)
    expect(calls[0].key).toMatch(/^outbox\//)
    expect(await left(t)).toEqual([])
  })

  test('a failed send is tried again, under the same key', async () => {
    answers = [503, 200]
    const t = await queued()
    await drain(t)
    expect(calls).toHaveLength(2)
    expect(calls[1].key).toBe(calls[0].key)
    expect(await left(t)).toEqual([])
  })

  test('no answer at all is tried again', async () => {
    answers = ['down', 200]
    const t = await queued()
    await drain(t)
    expect(calls).toHaveLength(2)
    expect(await left(t)).toEqual([])
  })

  test('a refusal that cannot get better is dropped at once', async () => {
    answers = [422]
    const t = await queued()
    await drain(t)
    expect(calls).toHaveLength(1)
    expect(await left(t)).toEqual([])
  })

  test('after the last try the message is dropped', async () => {
    answers = [503]
    const t = await queued()
    await drain(t)
    expect(calls).toHaveLength(6)
    expect(await left(t)).toEqual([])
  })

  test('the sweep drops what a crash left behind', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('outbox', {
        to: 'a@example.com',
        subject: 's',
        text: 'hi',
        created: Date.now() - 2 * 24 * 60 * 60 * 1000,
      }),
    )
    await t.mutation(internal.mail.sweep, {})
    expect(await left(t)).toEqual([])
  })
})
