import { describe, expect, test } from 'bun:test'
import { subscriptionChange, verifyStandardWebhook } from './polar'

const base = (over: Record<string, unknown> = {}) => ({
  type: 'subscription.active',
  timestamp: '2026-11-21T12:00:00Z',
  data: {
    id: 'sub_1',
    status: 'active',
    seats: 3,
    current_period_end: '2026-12-21T12:00:00Z',
    metadata: { account: 'alice', plan: 'team' },
    ...over,
  },
})

describe('what a Polar event means', () => {
  test('an active subscription is the plan the checkout named', () => {
    expect(subscriptionChange(base())).toEqual({
      handle: 'alice',
      plan: 'team',
      status: 'active',
      seats: 3,
      periodEnd: Date.parse('2026-12-21T12:00:00Z'),
      providerRef: 'sub_1',
      at: Date.parse('2026-11-21T12:00:00Z'),
    })
  })

  test('cancelled for the end of the period is still active until it is revoked', () => {
    const e = base({ status: 'active', cancel_at_period_end: true })
    expect(subscriptionChange(e)?.status).toBe('active')
    const ended = {
      ...base({ status: 'canceled' }),
      type: 'subscription.revoked',
    }
    expect(subscriptionChange(ended)?.status).toBe('lapsed')
  })

  test('a failed payment keeps access while Polar retries; unpaid does not', () => {
    expect(subscriptionChange(base({ status: 'past_due' }))?.status).toBe(
      'active',
    )
    expect(subscriptionChange(base({ status: 'unpaid' }))?.status).toBe(
      'lapsed',
    )
  })

  test('the plan can come from the product, and the account from the customer', () => {
    const e = base({
      metadata: {},
      product: { metadata: { plan: 'solo' } },
      customer: { external_id: 'bob' },
    })
    expect(subscriptionChange(e)).toMatchObject({ handle: 'bob', plan: 'solo' })
  })

  test('events about nothing we can place are ignored', () => {
    expect(subscriptionChange({ type: 'order.paid', data: {} })).toBeNull()
    expect(
      subscriptionChange(base({ metadata: { account: 'alice' } })),
    ).toBeNull()
    expect(
      subscriptionChange(
        base({ metadata: { account: 'alice', plan: 'free' } }),
      ),
    ).toBeNull()
    expect(
      subscriptionChange(
        base({ metadata: { account: 'alice', plan: 'gold' } }),
      ),
    ).toBeNull()
    expect(subscriptionChange('nonsense')).toBeNull()
  })
})

describe('the signature', () => {
  const NOW = Date.parse('2026-11-21T12:00:00Z')
  const sign = async (body: string, id: string, ts: string, secret: string) => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
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
    return btoa(String.fromCharCode(...mac))
  }
  const ts = String(NOW / 1000)

  test('a good one passes, and one among several is enough', async () => {
    const sig = await sign('{}', 'm1', ts, 's3cret')
    const h = { id: 'm1', timestamp: ts }
    expect(
      await verifyStandardWebhook(
        '{}',
        { ...h, signature: `v1,${sig}` },
        's3cret',
        NOW,
      ),
    ).toBeNull()
    expect(
      await verifyStandardWebhook(
        '{}',
        { ...h, signature: `v1,AAAA v1,${sig}` },
        's3cret',
        NOW,
      ),
    ).toBeNull()
  })

  test('a changed body, a wrong secret, a stale time and missing headers are refused', async () => {
    const sig = await sign('{}', 'm1', ts, 's3cret')
    const h = { id: 'm1', timestamp: ts, signature: `v1,${sig}` }
    expect(
      await verifyStandardWebhook('{"x":1}', h, 's3cret', NOW),
    ).not.toBeNull()
    expect(await verifyStandardWebhook('{}', h, 'other', NOW)).not.toBeNull()
    expect(
      await verifyStandardWebhook('{}', h, 's3cret', NOW + 10 * 60_000),
    ).not.toBeNull()
    expect(
      await verifyStandardWebhook(
        '{}',
        { ...h, signature: null },
        's3cret',
        NOW,
      ),
    ).not.toBeNull()
    expect(await verifyStandardWebhook('{}', h, undefined, NOW)).not.toBeNull()
  })
})
