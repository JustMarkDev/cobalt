import { describe, expect, test } from 'bun:test'
import { harness } from './testing'
import {
  DEFAULT_LANDING,
  landingVerification,
  landingWaits,
  parsePolicy,
} from './policy-file'

const R = '/repos/dana/gitfs'
let key = 0
const idem = () => ({
  'idempotency-key': `00000000-0000-4000-8000-${String(++key).padStart(12, '0')}`,
})

describe('the landing policy says where checks are verified', () => {
  test('before is the default, and a file may ask for after', () => {
    expect(DEFAULT_LANDING.verify).toBe('before')
    const ok = parsePolicy(
      'rules: []\nlanding:\n  verify: after\n  steps:\n    - wait_checks: [ci/e2e]\n',
      [],
    )
    expect(ok.errors).toEqual([])
    expect(ok.content?.landing.verify).toBe('after')
    const bad = parsePolicy('rules: []\nlanding:\n  verify: sometimes\n', [])
    expect(bad.errors.map((e) => e.message)).toContain(
      'verify is before or after.',
    )
  })

  test('only `before` makes the checks a gate; `after` reports them instead', () => {
    const steps = [{ wait_checks: ['ci/e2e'] }]
    const tree = 'T'
    const checks = [
      {
        id: 'k1',
        key: 'ci/e2e',
        name: 'ci/e2e',
        tree,
        state: 'fail' as const,
        updated: 1,
      },
    ]
    const before = { ...DEFAULT_LANDING, steps }
    const after = { ...DEFAULT_LANDING, verify: 'after' as const, steps }
    expect(landingWaits(before, checks, { tree })).toHaveLength(1)
    expect(landingWaits(after, checks, { tree })).toEqual([])
    expect(landingVerification(before, checks, { tree })).toBeNull()
    expect(landingVerification(after, [], { tree })).toEqual({
      state: 'pending',
      checks: [{ name: 'ci/e2e', state: 'pending' }],
    })
    expect(landingVerification(after, checks, { tree })?.state).toBe('failed')
    expect(
      landingVerification(after, [{ ...checks[0], state: 'pass' }], { tree })
        ?.state,
    ).toBe('passed')
    // A result for another tree says nothing about this one.
    expect(
      landingVerification(after, [{ ...checks[0], tree: 'other' }], { tree })
        ?.state,
    ).toBe('pending')
    expect(
      landingVerification({ ...after, steps: [] }, checks, { tree }),
    ).toBeNull()
  })
})

describe('through the API', () => {
  type H = ReturnType<typeof harness>

  // The rules move into the policy file with the first proposal; the file
  // applies once that change lands, like any other.
  async function applyLanding(h: H, body: object) {
    const made = await h.call('POST', `${R}/policy/proposals`, {
      body: { edits: [{ op: 'set_landing', ...body }] },
      headers: idem(),
    })
    expect(made.status).toBe(202)
    const n = made.json.change as number
    await h.call('POST', `${R}/changes/${n}/reviews`, {
      token: h.tokens.hollis,
      body: { state: 'approved' },
    })
    const before = (await h.call('GET', `${R}/changes/${n}/landability`)).json
    await h.call('POST', `${R}/changes/${n}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: before.tree },
    })
    const ready = (await h.call('GET', `${R}/changes/${n}/landability`)).json
    expect(ready.blockers).toEqual([])
    const landed = await h.call('POST', `${R}/changes/${n}/land`, {
      body: { expected_tree: ready.tree },
    })
    expect(landed.status).toBe(200)
  }

  const waits = (blockers: Array<{ id: string }>) =>
    blockers.filter((b) => b.id.startsWith('landing:wait_checks:'))

  test('with verify after, a failing check does not stop a change, and says it failed', async () => {
    const h = harness()
    await applyLanding(h, {
      verify: 'after',
      steps: [{ wait_checks: ['ci/e2e'] }],
    })
    const policy = (await h.call('GET', `${R}/policy`)).json
    expect(policy.yaml).toContain('verify: after')

    await h.call('POST', `${R}/changes/216/findings/F-2/resolve`)
    const url = `${R}/changes/216/landability`
    const pending = (await h.call('GET', url)).json
    expect(pending.landing.verify).toBe('after')
    expect(waits(pending.blockers)).toEqual([])
    expect(pending.verification).toEqual({
      state: 'pending',
      checks: [{ name: 'ci/e2e', state: 'pending' }],
    })

    const tree = pending.tree as string
    await h.call('POST', `${R}/changes/216/checks`, {
      body: { key: 'ci/test', state: 'pass', tree },
    })
    await h.call('POST', `${R}/changes/216/checks`, {
      body: { key: 'ci/e2e', state: 'fail', tree },
    })
    const failed = (await h.call('GET', url)).json
    expect(waits(failed.blockers)).toEqual([])
    expect(failed.verification.state).toBe('failed')
    expect(failed.landable).toBe(true)

    const landed = await h.call('POST', `${R}/changes/216/land`, {
      body: { expected_tree: tree },
    })
    expect([200, 202]).toContain(landed.status)
    await new Promise((r) => setTimeout(r, 100))
    expect((await h.call('GET', `${R}/changes/216`)).json.state).toBe('landed')

    await h.call('POST', `${R}/changes/216/checks`, {
      body: { key: 'ci/e2e', state: 'pass', tree },
    })
    expect((await h.call('GET', url)).json.verification.state).toBe('passed')
  })
})
