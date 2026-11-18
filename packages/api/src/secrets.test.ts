import { describe, expect, test } from 'bun:test'
import { personPrincipal } from './auth'
import { sampleTokens } from './sample'
import { clock, harness, onConvex } from './testing'
import type { ExtrasStore } from './extras'

const R = '/repos/dana/gitfs'
const E = `${R}/env`
const DEV_DB = 'postgres://dev:hunter2-dev-only@localhost:5432/gitfs'

/** A call as a person signed in to the app, the way the web app makes one. */
async function asSession(
  h: ReturnType<typeof harness>,
  handle: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await h.api.fetchAs(
    personPrincipal(handle, h.now()),
    new Request(`https://api.test/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

/** A token for someone, with the scopes a test needs. */
async function tokenFor(
  h: ReturnType<typeof harness>,
  handle: string,
  scopes: Array<string>,
  device = 'Laptop',
) {
  const { secret } = await h.api.port.svc.auth.create({
    name: `${handle} test`,
    kind: 'personal',
    handle,
    device,
    scopes: scopes as never,
    ttlMs: 86_400_000,
  })
  return secret
}

describe('who gets values: the team, and nobody else', () => {
  test('the team reads development values, through a token', async () => {
    const h = harness()
    const r = await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.scoped,
    })
    expect(r.status).toBe(200)
    expect(r.json.values.DATABASE_URL).toBe(DEV_DB)
    expect(r.json.secrets).toContain('DATABASE_URL')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  test('a collaborator sees names, never values, even with the scope', async () => {
    const h = harness()
    const hollis = await tokenFor(h, 'hollis', [
      'repo:read',
      'secrets:schema',
      'secrets:decrypt',
    ])
    expect((await h.call('GET', E, { token: hollis })).status).toBe(200)
    const r = await h.call('GET', `${E}/development/values`, { token: hollis })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('forbidden')
  })

  test('someone with no part in the repository cannot even see its variables', async () => {
    const h = harness()
    for (const path of [E, `${E}/development/values`])
      expect(
        (await h.call('GET', path, { token: sampleTokens.stranger })).status,
      ).toBe(404)
  })

  test('a token without secrets:decrypt cannot read values', async () => {
    const h = harness()
    const r = await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.issuesOnly,
    })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('insufficient_scope')
  })

  test('a page in a browser never gets values, so a script in it cannot read them', async () => {
    const h = harness()
    const r = await asSession(h, 'dana', 'GET', `${E}/development/values`)
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('forbidden')
  })
})

describe('production needs you to confirm, from a signed-in page', () => {
  test('a token asks, is told where to confirm, and nothing is read', async () => {
    const h = harness()
    const r = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('confirmation_required')
    expect(r.json.confirm_url).toContain('/dana/gitfs/settings')
    expect(r.json.confirmation).toMatchObject({
      state: 'pending',
      login: 'dana',
      device: 'Laptop',
    })
    expect(JSON.stringify(r.json)).not.toContain('sk_test')
  })

  test('a token cannot confirm, not even its own request', async () => {
    const h = harness()
    const asked = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    const id = asked.json.confirmation.id
    // The token that asked has no secrets:write; the person's full token has
    // every scope. Neither can confirm.
    const own = await h.call('POST', `${E}/confirmations/${id}/confirm`, {
      token: sampleTokens.scoped,
      body: { ttl_minutes: 60 },
    })
    expect(own.status).toBe(403)
    const full = await h.call('POST', `${E}/confirmations/${id}/confirm`, {
      token: sampleTokens.dana,
      body: { ttl_minutes: 60 },
    })
    expect(full.status).toBe(403)
    expect(full.json.code).toBe('session_required')
    expect(
      (
        await h.call('GET', `${E}/production/values`, {
          token: sampleTokens.scoped,
        })
      ).status,
    ).toBe(403)
  })

  test('only the person whose login asked can confirm it', async () => {
    const h = harness()
    const asked = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    const r = await asSession(
      h,
      'hollis',
      'POST',
      `${E}/confirmations/${asked.json.confirmation.id}/confirm`,
      {},
    )
    // hollis is not in the team; even a teammate would get 404 for a request
    // that is not theirs.
    expect(r.status).toBe(403)
    const mine = await h.call('GET', `${E}/confirmations`, {
      token: sampleTokens.scoped,
    })
    expect(mine.json.data[0].state).toBe('pending')
  })

  test('confirmed from the page, that one login reads production; another login asks again', async () => {
    const h = harness()
    const asked = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    const ok = await asSession(
      h,
      'dana',
      'POST',
      `${E}/confirmations/${asked.json.confirmation.id}/confirm`,
      { ttl_minutes: 30 },
    )
    expect(ok.status).toBe(200)
    expect(ok.json.state).toBe('active')
    const read = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    expect(read.status).toBe(200)
    expect(read.json.values.STRIPE_KEY).toBe('sk_test_51MockMockMockMock9x')
    expect(read.json.confirmation).toBe(asked.json.confirmation.id)
    // The same person on another machine is another login: it asks for itself.
    const other = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.dana,
    })
    expect(other.json.code).toBe('confirmation_required')
  })

  test('a confirmation runs out, and ending it works at once', async () => {
    const now = clock()
    const h = harness({ now })
    const asked = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    const id = asked.json.confirmation.id
    await asSession(h, 'dana', 'POST', `${E}/confirmations/${id}/confirm`, {
      ttl_minutes: 5,
    })
    const read = () =>
      h.call('GET', `${E}/production/values`, { token: sampleTokens.scoped })
    expect((await read()).status).toBe(200)
    // Ending it takes secrets:write: from the page, or a token that may set values.
    expect(
      (await asSession(h, 'dana', 'POST', `${E}/confirmations/${id}/revoke`))
        .json.state,
    ).toBe('revoked')
    expect((await read()).json.code).toBe('confirmation_required')

    // A fresh confirmation, then time passes it by.
    const again = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    await asSession(
      h,
      'dana',
      'POST',
      `${E}/confirmations/${again.json.confirmation.id}/confirm`,
      { ttl_minutes: 5 },
    )
    expect((await read()).status).toBe(200)
    now.advance(6 * 60_000)
    expect((await read()).json.code).toBe('confirmation_required')
  })

  test('an unanswered request lapses and cannot be confirmed late', async () => {
    const now = clock()
    const h = harness({ now })
    const asked = await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    now.advance(11 * 60_000)
    const r = await asSession(
      h,
      'dana',
      'POST',
      `${E}/confirmations/${asked.json.confirmation.id}/confirm`,
      {},
    )
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('invalid_state')
  })

  test('setting a production value from a token needs the same confirmation', async () => {
    const h = harness()
    const r = await h.call('PUT', `${E}/STRIPE_KEY/production`, {
      body: { value: 'sk_live_swapped' },
    })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('confirmation_required')
    // From the page, the person sets it directly.
    const page = await asSession(
      h,
      'dana',
      'PUT',
      `${E}/STRIPE_KEY/production`,
      {
        value: 'sk_live_from_the_page',
      },
    )
    expect(page.status).toBe(200)
  })

  test('you see only your own requests', async () => {
    const h = harness()
    await h.call('GET', `${E}/production/values`, {
      token: sampleTokens.scoped,
    })
    const mine = await h.call('GET', `${E}/confirmations`, {
      token: sampleTokens.scoped,
    })
    expect(mine.json.data).toHaveLength(1)
    const hollis = await tokenFor(h, 'hollis', ['repo:read', 'secrets:schema'])
    const theirs = await h.call('GET', `${E}/confirmations`, { token: hollis })
    expect(theirs.json.data).toHaveLength(0)
  })
})

describe('values are sealed, and never leave any other way', () => {
  test('setting seals the value and never answers it back', async () => {
    const h = harness()
    const r = await h.call('PUT', `${E}/STRIPE_KEY/development`, {
      body: { value: 'sk_test_brand_new_value_1234' },
    })
    expect(r.status).toBe(200)
    expect(r.text).not.toContain('sk_test_brand_new_value_1234')
    const kept = JSON.stringify(
      (h.api.domain.svc.extras as ExtrasStore).for('dana/gitfs'),
    )
    expect(kept).not.toContain('sk_test_brand_new_value_1234')
    expect(kept).not.toContain('hunter2')
    const back = await h.call(
      'GET',
      `${E}/development/values?names=STRIPE_KEY`,
      {
        token: sampleTokens.scoped,
      },
    )
    expect(back.json.values).toEqual({
      STRIPE_KEY: 'sk_test_brand_new_value_1234',
    })
  })

  test('a name has to be in the schema first', async () => {
    const h = harness()
    const r = await h.call('PUT', `${E}/NOT_A_VARIABLE/development`, {
      body: { value: 'x' },
    })
    expect(r.status).toBe(400)
    expect(r.json.errors[0].code).toBe('not_in_schema')
  })

  test('a value takes no Idempotency-Key, since the key would keep a hash of it', async () => {
    const h = harness()
    const r = await h.call('PUT', `${E}/STRIPE_KEY/development`, {
      body: { value: 'short' },
      headers: { 'idempotency-key': 'a2c4e6f8-1111-4222-8333-944455556666' },
    })
    expect(r.status).toBe(400)
  })

  // Moves the ciphertext inside the memory store; the check it proves is in
  // the operation, which both backends share.
  test.skipIf(onConvex)(
    'a sealed value moved to another variable does not open there',
    async () => {
      const h = harness()
      await h.call('GET', `${E}/development/values`, {
        token: sampleTokens.scoped,
      })
      const x = (h.api.domain.svc.extras as ExtrasStore).for('dana/gitfs')
      // Someone with the database swaps one ciphertext into another slot.
      x.sealed.API_PORT.development = x.sealed.DATABASE_URL.development
      const r = await h.call('GET', `${E}/development/values`, {
        token: sampleTokens.scoped,
      })
      expect(r.json.values.API_PORT).toBeUndefined()
      expect(r.json.values.DATABASE_URL).toBe(DEV_DB)
      const audit = (await h.call('GET', `${E}/audit`)).json.data
      expect(audit[0]).toMatchObject({ kind: 'reject' })
    },
  )

  test('without a secrets key the server keeps and gives out nothing', async () => {
    const h = harness()
    h.api.port.svc.secrets = Promise.resolve(null)
    const read = await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.scoped,
    })
    expect(read.status).toBe(503)
    expect(read.json.code).toBe('secrets_unavailable')
    const write = await h.call('PUT', `${E}/STRIPE_KEY/development`, {
      body: { value: 'x' },
    })
    expect(write.json.code).toBe('secrets_unavailable')
    // Names still work: they were never secret.
    expect((await h.call('GET', E)).status).toBe(200)
  })

  test('no value reaches events, the sync feed or the agent start-up bundle', async () => {
    const h = harness()
    await h.call('PUT', `${E}/STRIPE_KEY/development`, {
      body: { value: 'sk_test_never_in_a_feed_9876' },
    })
    await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.scoped,
    })
    for (const path of [`/sync`, `${R}/context`, `/events?limit=200`]) {
      const r = await h.call('GET', path)
      expect(r.text, path).not.toContain('sk_test_never_in_a_feed_9876')
      expect(r.text, path).not.toContain('hunter2')
    }
  })

  test('every read is audited with the machine, tool and model it came from', async () => {
    const h = harness()
    await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.scoped,
      headers: { 'sx-tool': 'T3 Code', 'sx-model': 'Claude Opus 5.5' },
    })
    const audit = (await h.call('GET', `${E}/audit`)).json.data
    expect(audit[0]).toMatchObject({
      kind: 'read',
      who: 'dana on Laptop via T3 Code (Claude Opus 5.5)',
    })
  })

  test('variables say which environments need them and when they last changed', async () => {
    const h = harness()
    const list = (await h.call('GET', `${E}?environment=production`)).json.data
    const db = list.find((v: { name: string }) => v.name === 'DATABASE_URL')
    expect(db).toMatchObject({
      required: ['development', 'production'],
      rotated_by: 'dana',
      set: true,
    })
    expect(JSON.stringify(list)).not.toContain('hunter2')
  })
})

describe('two reads at once', () => {
  test('both get values, and both are in the audit log', async () => {
    const h = harness()
    const read = () =>
      h.call('GET', `${E}/development/values`, { token: sampleTokens.scoped })
    const [a, b] = await Promise.all([read(), read()])
    expect([a.status, b.status]).toEqual([200, 200])
    const audit = (await h.call('GET', `${E}/audit`)).json.data as Array<{
      kind: string
    }>
    expect(
      audit.filter((e) => e.kind === 'read').length,
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('a confirmation belongs to the login', () => {
  test('it outlives the hourly access token: a refreshed token keeps it', async () => {
    const h = harness()
    const mint = async () =>
      (
        await h.api.port.svc.auth.create({
          name: 'sx command line',
          kind: 'oauth',
          handle: 'dana',
          device: 'Laptop',
          scopes: ['repo:read', 'secrets:schema', 'secrets:decrypt'] as never,
          ttlMs: 3_600_000,
          authorizationId: 'atz_same_login_0001',
        })
      ).secret
    const first = await mint()
    const asked = await h.call('GET', `${E}/production/values`, {
      token: first,
    })
    expect(asked.json.code).toBe('confirmation_required')
    await asSession(
      h,
      'dana',
      'POST',
      `${E}/confirmations/${asked.json.confirmation.id}/confirm`,
      { ttl_minutes: 60 },
    )
    const refreshed = await mint()
    const r = await h.call('GET', `${E}/production/values`, {
      token: refreshed,
    })
    expect(r.status).toBe(200)
  })
})

describe('values stay with the team that set them', () => {
  test('a transfer clears every value; names stay', async () => {
    const h = harness()
    const moved = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'northwind', confirm: 'dana/gitfs' },
    })
    expect(moved.status).toBe(200)
    const r = await h.call(
      'GET',
      '/repos/northwind/gitfs/env/development/values',
      {
        token: sampleTokens.dana,
      },
    )
    expect(r.json.values).toEqual({})
    const names = (await h.call('GET', '/repos/northwind/gitfs/env')).json.data
    expect(names.length).toBeGreaterThan(0)
  })

  test("the audit log is the team's, like the values", async () => {
    const h = harness()
    const hollis = await tokenFor(h, 'hollis', [
      'repo:read',
      'repo:write',
      'secrets:schema',
    ])
    const r = await h.call('GET', `${E}/audit`, { token: hollis })
    expect(r.status).toBe(403)
  })

  test('without a master key the server keeps no values, even in the sample', async () => {
    const h = harness({ ephemeralSecrets: false })
    const r = await h.call('GET', `${E}/development/values`, {
      token: sampleTokens.scoped,
    })
    expect(r.json.code).toBe('secrets_unavailable')
  })

  test('a dry run says production would wait, and asks the person nothing', async () => {
    const h = harness()
    const dry = await h.call('GET', `${E}/production/values?check_only=true`, {
      token: sampleTokens.scoped,
    })
    expect(dry.json.code).toBe('confirmation_required')
    const mine = await h.call('GET', `${E}/confirmations`, {
      token: sampleTokens.scoped,
    })
    expect(mine.json.data).toEqual([])
  })
})

describe('a transfer, and what does not cross', () => {
  test('a no-op or a rename in the same account keeps every value', async () => {
    const h = harness()
    const same = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'dana', confirm: 'dana/gitfs' },
    })
    expect(same.status).toBe(200)
    const read = (path: string) =>
      h.call('GET', `${path}/env/development/values`, {
        token: sampleTokens.dana,
      })
    expect((await read(R)).json.values.DATABASE_URL).toBe(DEV_DB)
    const renamed = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'dana', name: 'gitfs2', confirm: 'dana/gitfs' },
    })
    expect(renamed.status).toBe(200)
    expect((await read('/repos/dana/gitfs2')).json.values.DATABASE_URL).toBe(
      DEV_DB,
    )
  })

  test('to another owner: old grants, maintainers and limited tokens stay behind', async () => {
    const h = harness()
    const ines = await tokenFor(h, 'ines', ['repo:read', 'pulls:write'])
    // ines could write to dana/gitfs as a collaborator.
    const before = await h.call('POST', `${R}/changes`, {
      token: ines,
      body: { branch: 'before-transfer' },
    })
    expect(before.status).toBe(201)
    await h.call('PATCH', R, { body: { auto_land: true } })
    await h.call('POST', `${R}/transfer`, {
      body: { owner: 'northwind', confirm: 'dana/gitfs' },
    })
    const repo = (await h.call('GET', '/repos/northwind/gitfs')).json
    expect(repo.maintainers).toEqual([])
    expect(repo.auto_land).toBe(false)
    // She is not in northwind: what dana granted stayed with dana.
    const after = await h.call('POST', '/repos/northwind/gitfs/changes', {
      token: ines,
      body: { branch: 'after-transfer' },
    })
    expect(after.status).not.toBe(201)
  })
})

test('a token limited to a repository does not follow it to a new owner', async () => {
  const h = harness()
  const { secret } = await h.api.port.svc.auth.create({
    name: 'only gitfs',
    kind: 'personal',
    handle: 'dana',
    device: 'Laptop',
    scopes: ['repo:read', 'pulls:write'] as never,
    repos: ['dana/gitfs'],
    ttlMs: 86_400_000,
  })
  const open = (path: string, branch: string) =>
    h.call('POST', `${path}/changes`, { token: secret, body: { branch } })
  expect((await open(R, 'before')).status).toBe(201)
  await h.call('POST', `${R}/transfer`, {
    body: { owner: 'northwind', confirm: 'dana/gitfs' },
  })
  // dana owns northwind too, but this token was for her repository, not theirs.
  expect((await open('/repos/northwind/gitfs', 'after')).status).not.toBe(201)
})

test('a signed-in page cannot make itself a token that reads values', async () => {
  const h = harness()
  const r = await asSession(h, 'dana', 'POST', '/tokens', {
    name: 'from a page',
    scopes: ['repo:read', 'secrets:decrypt'],
    expires_in_days: 30,
  })
  expect(r.status).toBe(403)
  const ok = await asSession(h, 'dana', 'POST', '/tokens', {
    name: 'from a page',
    scopes: ['repo:read'],
    expires_in_days: 30,
  })
  expect(ok.status).toBe(201)
})
