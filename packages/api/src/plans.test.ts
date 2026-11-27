import { describe, expect, test } from 'bun:test'
import {
  DELETION_GRACE_MS,
  GB,
  LAPSED_KEEP_MS,
  allowsPrivate,
  effectivePlan,
  limitsFor,
  overQuota,
  planLimits,
  planOrder,
  repoState,
} from './plans'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY = 86_400_000

describe('the effective plan', () => {
  test('an account with nothing is on Free', () => {
    expect(effectivePlan(null, [], NOW)).toEqual({
      plan: 'free',
      source: 'free',
      until: null,
      lapsedAt: null,
      unlimited: false,
    })
  })

  test('a standing grant never ends and lifts every limit', () => {
    const e = effectivePlan(
      { plan: 'team', status: 'active' },
      [{ plan: 'solo', expires: null }],
      NOW + 1000 * DAY,
    )
    expect(e).toEqual({
      plan: 'business',
      source: 'grant',
      until: null,
      lapsedAt: null,
      unlimited: true,
    })
  })

  test('a revoked standing grant no longer applies', () => {
    const e = effectivePlan(null, [{ plan: 'business', revoked: NOW }], NOW)
    expect(e).toMatchObject({ plan: 'free', unlimited: false })
  })

  test('an active subscription is its plan', () => {
    const e = effectivePlan({ plan: 'team', status: 'active' }, [], NOW)
    expect(e).toMatchObject({ plan: 'team', source: 'subscription' })
  })

  test('a grant lifts Free to its plan until it ends, then Free again', () => {
    const grant = { plan: 'business' as const, expires: NOW + 60 * DAY }
    expect(effectivePlan(null, [grant], NOW)).toMatchObject({
      plan: 'business',
      source: 'grant',
      until: NOW + 60 * DAY,
    })
    expect(effectivePlan(null, [grant], NOW + 61 * DAY).plan).toBe('free')
  })

  test('a revoked grant counts for nothing', () => {
    const grant = {
      plan: 'business' as const,
      expires: NOW + 60 * DAY,
      revoked: NOW - DAY,
    }
    expect(effectivePlan(null, [grant], NOW).plan).toBe('free')
  })

  test('the best of the subscription and the grants wins, and a tie goes to the subscription', () => {
    const sub = { plan: 'solo' as const, status: 'active' as const }
    const grant = { plan: 'team' as const, expires: NOW + DAY }
    expect(effectivePlan(sub, [grant], NOW).plan).toBe('team')
    expect(
      effectivePlan(sub, [{ plan: 'solo', expires: NOW + DAY }], NOW).source,
    ).toBe('subscription')
  })

  test('a lapsed subscription falls to Free and remembers when it ended', () => {
    const e = effectivePlan(
      { plan: 'solo', status: 'lapsed', lapsedAt: NOW - 10 * DAY },
      [],
      NOW,
    )
    expect(e).toMatchObject({ plan: 'free', lapsedAt: NOW - 10 * DAY })
  })

  test('a lapsed subscription does not hide a live grant', () => {
    const e = effectivePlan(
      { plan: 'solo', status: 'lapsed', lapsedAt: NOW - DAY },
      [{ plan: 'team', expires: NOW + DAY }],
      NOW,
    )
    expect(e).toMatchObject({ plan: 'team', source: 'grant', lapsedAt: null })
  })
})

describe('what a plan allows', () => {
  test('a person may keep private repositories on every plan', () => {
    expect(planOrder.filter((p) => !allowsPrivate(p, 'person'))).toEqual([])
  })

  test('an organization on Free has no private repositories', () => {
    expect(planOrder.filter((p) => !allowsPrivate(p, 'organization'))).toEqual([
      'free',
    ])
  })

  test('a seat never has less than the plan below it', () => {
    for (const k of ['storageGb', 'transferGb', 'pushGb'] as const)
      for (let i = 1; i < planOrder.length; i++)
        expect(planLimits[planOrder[i]][k]).toBeGreaterThanOrEqual(
          planLimits[planOrder[i - 1]][k],
        )
  })

  test('Team and Business grow with their seats; Free and Pro do not', () => {
    expect(limitsFor('team', 4)).toEqual({
      storageGb: 12,
      transferGb: 200,
      pushGb: 40,
    })
    expect(limitsFor('business', 2).storageGb).toBe(20)
    expect(limitsFor('solo', 9)).toEqual(planLimits.solo)
    expect(limitsFor('free', 9)).toEqual(planLimits.free)
    expect(limitsFor('team', 0)).toEqual(planLimits.team)
  })

  test('a private repository of an organization on Free only reads', () => {
    expect(repoState('free', 'private', false, 'organization')).toEqual({
      writable: false,
      why: 'plan',
    })
    expect(repoState('free', 'private', false, 'person')).toEqual({
      writable: true,
    })
    expect(repoState('free', 'public', false, 'organization')).toEqual({
      writable: true,
    })
    expect(repoState('team', 'private', false, 'organization')).toEqual({
      writable: true,
    })
  })

  test('everything of an account waiting to be deleted only reads', () => {
    expect(repoState('business', 'public', true, 'person')).toEqual({
      writable: false,
      why: 'deletion',
    })
  })

  test('the promises in the terms', () => {
    expect(DELETION_GRACE_MS).toBe(30 * DAY)
    expect(LAPSED_KEEP_MS).toBe(90 * DAY)
  })
})

describe('the allowance', () => {
  const none = { storageBytes: 0, transferBytes: 0, pushBytes: 0 }

  test('Free is held to its three limits, and each says which', () => {
    expect(overQuota('free', none)).toBeNull()
    expect(overQuota('free', { ...none, storageBytes: 0.1 * GB })).toBeNull()
    expect(overQuota('free', { ...none, storageBytes: 0.1 * GB + 1 })).toBe(
      'storage',
    )
    expect(overQuota('free', { ...none, transferBytes: 0.5 * GB + 1 })).toBe(
      'transfer',
    )
    expect(overQuota('free', { ...none, pushBytes: 0.1 * GB + 1 })).toBe('push')
  })

  test('a paid plan is never paused: it is billed for the excess', () => {
    const huge = { storageBytes: 1e12, transferBytes: 1e12, pushBytes: 1e12 }
    for (const p of ['solo', 'team', 'business'] as const)
      expect(overQuota(p, huge)).toBeNull()
  })

  test('past the allowance a repository stops taking pushes, but a private one of an organization on Free says plan first', () => {
    expect(repoState('free', 'public', false, 'person', 'storage')).toEqual({
      writable: false,
      why: 'quota',
    })
    expect(repoState('free', 'private', false, 'person', 'storage')).toEqual({
      writable: false,
      why: 'quota',
    })
    expect(
      repoState('free', 'private', false, 'organization', 'storage'),
    ).toEqual({
      writable: false,
      why: 'plan',
    })
  })
})
