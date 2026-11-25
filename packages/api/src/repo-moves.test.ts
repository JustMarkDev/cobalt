import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { harness, onConvex } from './testing'

const R = '/repos/dana/gitfs'

describe('transferring a repository', () => {
  test('moves it, and the old address points at the new one', async () => {
    const h = harness()
    const moved = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'northwind', confirm: 'dana/gitfs' },
    })
    expect(moved.status).toBe(200)
    expect(moved.json).toMatchObject({ owner: 'northwind', name: 'gitfs' })
    const old = await h.call('GET', R)
    expect(old.status).toBe(308)
    expect(old.headers.get('location')).toContain('/repos/northwind/gitfs')
    expect(
      (await h.call('GET', '/repos/northwind/gitfs/changes')).json.data.length,
    ).toBeGreaterThan(0)
    expect(
      (await h.call('GET', '/repos/northwind/gitfs/releases')).status,
    ).toBe(200)
  })

  test('needs the name typed out, and a place you manage', async () => {
    const h = harness()
    const unconfirmed = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'northwind', confirm: 'gitfs' },
    })
    expect(unconfirmed.status).toBe(400)
    const member = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'lumen-studio', confirm: 'dana/gitfs' },
    })
    expect(member.status).toBe(403)
    const nowhere = await h.call('POST', `${R}/transfer`, {
      body: { owner: 'no-such-account', confirm: 'dana/gitfs' },
    })
    expect(nowhere.status).toBe(404)
    const notAdmin = await h.call('POST', `${R}/transfer`, {
      token: sampleTokens.hollis,
      body: { owner: 'hollis', confirm: 'dana/gitfs' },
    })
    expect(notAdmin.status).toBe(403)
  })

  test('a dry run changes nothing', async () => {
    const h = harness()
    const dry = await h.call('POST', `${R}/transfer?dry_run=true`, {
      body: { owner: 'northwind', name: 'gitfs2', confirm: 'dana/gitfs' },
    })
    expect(dry.json.full_name).toBe('northwind/gitfs2')
    expect((await h.call('GET', R)).status).toBe(200)
  })
})

describe('pausing a mirror', () => {
  test.skipIf(onConvex)(
    'a paused mirror refuses to sync until it is resumed',
    async () => {
      const h = harness()
      const [m] = (await h.call('GET', `${R}/mirrors`)).json.data
      expect(m.paused).toBe(false)
      const paused = await h.call('PATCH', `${R}/mirrors/${m.id}`, {
        body: { paused: true },
      })
      expect(paused.json.paused).toBe(true)
      expect(
        (await h.call('POST', `${R}/mirrors/${m.id}/sync`)).json.code,
      ).toBe('invalid_state')
      await h.call('PATCH', `${R}/mirrors/${m.id}`, { body: { paused: false } })
      expect((await h.call('POST', `${R}/mirrors/${m.id}/sync`)).status).toBe(
        200,
      )
    },
  )
})
