import { expect, test } from 'bun:test'
import { redisTier, sharedTierFromEnv } from './redis-tier'
import type { RedisLike } from './redis-tier'

function fake() {
  const rows = new Map<string, string>()
  const seen: Array<Array<unknown>> = []
  const client: RedisLike & { down: boolean; slow: boolean } = {
    down: false,
    slow: false,
    async get(k) {
      if (client.down) throw new Error('refused')
      if (client.slow) await new Promise((r) => setTimeout(r, 50))
      return rows.get(k) ?? null
    },
    set(k, v, ...rest) {
      if (client.down) return Promise.reject(new Error('refused'))
      seen.push([k, ...rest])
      rows.set(k, v)
      return Promise.resolve('OK')
    },
  }
  return { client, rows, seen }
}

test('stores under a prefix with an expiry, and reads it back', async () => {
  const { client, rows, seen } = fake()
  const tier = redisTier(client, { ttlSeconds: 60 })
  await tier.set('a', 'x')
  expect([...rows.keys()]).toEqual(['cb:git:v1:a'])
  expect(seen[0]).toEqual(['cb:git:v1:a', 'EX', 60])
  expect(await tier.get('a')).toBe('x')
  expect(await tier.get('b')).toBeNull()
})

test('a down or slow redis is a miss, and is left alone for a while', async () => {
  let t = 0
  const { client } = fake()
  const tier = redisTier(client, {
    timeoutMs: 10,
    coolOffMs: 1_000,
    now: () => t,
  })
  await tier.set('a', 'x')
  client.slow = true
  expect(await tier.get('a')).toBeNull()
  client.slow = false
  expect(await tier.get('a')).toBeNull()
  t = 1_001
  expect(await tier.get('a')).toBe('x')
  client.down = true
  expect(await tier.get('a')).toBeNull()
  await tier.set('b', 'y')
})

test('there is no tier without GIT_CACHE_REDIS_URL, and a bad client is no tier', () => {
  expect(sharedTierFromEnv({}, () => fake().client)).toBeUndefined()
  expect(
    sharedTierFromEnv(
      { GIT_CACHE_REDIS_URL: 'redis://x' },
      () => fake().client,
    ),
  ).toBeDefined()
  expect(
    sharedTierFromEnv({ GIT_CACHE_REDIS_URL: 'nope' }, () => {
      throw new Error('bad url')
    }),
  ).toBeUndefined()
})
