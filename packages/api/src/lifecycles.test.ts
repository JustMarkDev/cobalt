import { afterEach, describe, expect, test } from 'bun:test'
import {
  automationNextRun,
  canMove,
  changeLifecycle,
  changeTarget,
  deliveryLifecycle,
  deviceLifecycle,
  grantLifecycle,
  isTerminal,
  landingStepLifecycle,
  operationLifecycle,
  pipelineLifecycle,
  pipelineStepLifecycle,
  reportStep,
  runLifecycle,
  runStateAt,
  uploadLifecycle,
  uploadMoveRefusal,
} from './lifecycles'
import { MemoryOAuthState } from './oauth-state'
import { ConvexOAuthState } from './stores/convex-tokens'
import { clock, harness } from './testing'
import type { Machine } from './lifecycles'

/**
 * Every record that moves through states does so by `lifecycles.ts`, and
 * each test here first reproduces a way the state used to move wrongly.
 */

const R = '/repos/dana/gitfs'

describe('the tables', () => {
  const all: Array<Machine<string>> = [
    changeLifecycle,
    runLifecycle,
    operationLifecycle,
    landingStepLifecycle,
    pipelineLifecycle,
    pipelineStepLifecycle,
    deliveryLifecycle,
    uploadLifecycle,
    deviceLifecycle,
    grantLifecycle,
  ] as never

  test.each(all.map((m) => [m.name, m] as const))(
    '%s: every move leads to a state it has',
    (_, m) => {
      for (const tos of Object.values(m.moves))
        for (const to of tos as Array<string>)
          expect(Object.keys(m.moves)).toContain(to)
      // And something is final (an upload's end is being attached, kept
      // apart from its state).
      if (m !== (uploadLifecycle as never))
        expect(Object.keys(m.moves).some((s) => isTerminal(m, s))).toBe(true)
    },
  )

  test('a landed change never moves; a change lands only from open', () => {
    expect(isTerminal(changeLifecycle, 'landed')).toBe(true)
    expect(changeTarget('land', { state: 'draft' })).toBeNull()
    expect(changeTarget('land', { state: 'abandoned' })).toBeNull()
    expect(changeTarget('land', { state: 'open' })).toBe('landed')
    expect(changeTarget('ready', { state: 'open' })).toBeNull()
  })

  test('restoring returns a change to the state it was abandoned from', () => {
    expect(
      changeTarget('restore', { state: 'abandoned', abandonedFrom: 'draft' }),
    ).toBe('draft')
    expect(
      changeTarget('restore', { state: 'abandoned', abandonedFrom: 'open' }),
    ).toBe('open')
    // Abandoned before it was remembered: open, as it always was.
    expect(changeTarget('restore', { state: 'abandoned' })).toBe('open')
  })

  test('a run past its deadline reads as expired, and expired is final', () => {
    const r = { state: 'running' as const, expires: 1000 }
    expect(runStateAt(r, 999)).toBe('running')
    expect(runStateAt(r, 1000)).toBe('expired')
    expect(isTerminal(runLifecycle, 'expired')).toBe(true)
    expect(canMove(runLifecycle, 'succeeded', 'expired')).toBe(false)
  })

  test('a delivery that finished never goes back', () => {
    expect(canMove(deliveryLifecycle, 'succeeded', 'failed')).toBe(false)
    expect(canMove(deliveryLifecycle, 'failed', 'succeeded')).toBe(false)
  })

  test('an upload gets its file once and is attached once', () => {
    const pending = {
      state: 'pending' as const,
      sha256: null,
      attachedTo: null,
    }
    const up = { state: 'uploaded' as const, sha256: 'a', attachedTo: null }
    expect(uploadMoveRefusal(pending, up)).toBeNull()
    expect(uploadMoveRefusal(up, up)).toBeNull()
    expect(uploadMoveRefusal(up, { ...up, sha256: 'b' })).toContain('already')
    expect(
      uploadMoveRefusal(pending, { ...pending, attachedTo: 'dana/gitfs' }),
    ).toContain('once its file has arrived')
    const attached = { ...up, attachedTo: 'dana/gitfs' }
    expect(uploadMoveRefusal(up, attached)).toBeNull()
    expect(
      uploadMoveRefusal(attached, { ...up, attachedTo: 'dana/other' }),
    ).toContain('already attached')
    // A save never takes a file away.
    expect(uploadMoveRefusal(up, pending)).toContain('cannot become pending')
  })

  test('a device code is answered once', () => {
    expect(canMove(deviceLifecycle, 'pending', 'approved')).toBe(true)
    expect(canMove(deviceLifecycle, 'approved', 'denied')).toBe(false)
    expect(canMove(deviceLifecycle, 'denied', 'approved')).toBe(false)
  })

  test('a turned-off automation has no next run', () => {
    const a = {
      enabled: true,
      triggers: ['schedule'],
      every: 'day',
      created: 0,
    }
    expect(automationNextRun(a)).toBe(86_400_000)
    expect(automationNextRun({ ...a, enabled: false })).toBeNull()
    expect(automationNextRun({ ...a, triggers: ['change.opened'] })).toBeNull()
  })

  test('a pipeline step is reported in order, forward only', () => {
    const run = () => ({
      number: 7,
      status: 'running',
      jobs: [
        {
          status: 'running',
          duration: 0,
          steps: [
            { status: 'queued', duration: 0 },
            { status: 'queued', duration: 0 },
          ],
        },
      ],
    })
    expect(reportStep(run(), 1, 2, 'success')).toEqual({
      refusal: 'Step 2 of job 1 cannot be reported yet: step 1 is queued.',
    })
    const r = run()
    expect(reportStep(r, 1, 1, 'success')).toEqual({ repeated: false })
    expect(reportStep(r, 1, 1, 'success')).toEqual({ repeated: true })
    expect(reportStep(r, 1, 1, 'running')).toEqual({
      refusal: 'Step 1 of job 1 is success; it cannot become running.',
    })
  })
})

describe('changes', () => {
  test('a draft that is abandoned and restored is a draft again', async () => {
    const h = harness()
    // #217 in the sample is a draft.
    const abandoned = await h.call('POST', `${R}/changes/217/abandon`)
    expect(abandoned.status).toBe(200)
    expect(abandoned.json.state).toBe('abandoned')
    const restored = await h.call('POST', `${R}/changes/217/restore`)
    expect(restored.status).toBe(200)
    // It used to come back open: ready to land without anyone marking it so.
    expect(restored.json.state).toBe('draft')
    // And it can be marked ready, as any draft.
    const ready = await h.call('POST', `${R}/changes/217/ready`)
    expect(ready.json.state).toBe('open')
  })

  test('an open change that is abandoned and restored is open again', async () => {
    const h = harness()
    const open = (await h.call('GET', `${R}/changes?state=open`)).json.data[0]
    await h.call('POST', `${R}/changes/${open.number}/abandon`)
    const restored = await h.call('POST', `${R}/changes/${open.number}/restore`)
    expect(restored.json.state).toBe('open')
  })
})

describe('pipelines', () => {
  async function claimed(h: ReturnType<typeof harness>) {
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    for (let i = 0; i < 20; i++) {
      const c = (
        await h.call('POST', `${R}/pipelines/claim`, { body: { runner: 'r' } })
      ).json
      if (c.run === run.number) return c
    }
    throw new Error('never claimed')
  }
  const step = (
    h: ReturnType<typeof harness>,
    job: { run: number; job: number },
    n: number,
    status: string,
  ) =>
    h.call('POST', `${R}/pipelines/${job.run}/jobs/${job.job}/steps/${n}`, {
      body: { status, lines: [{ text: `step ${n} ${status}`, level: 'ok' }] },
    })

  test('a step cannot be reported before the steps ahead of it', async () => {
    const h = harness()
    const job = await claimed(h)
    expect(job.steps.length).toBeGreaterThan(1)
    // It used to be taken: step 2 done while step 1 had not started.
    const early = await step(h, job, 2, 'success')
    expect(early.status).toBe(409)
    expect(early.json.code).toBe('invalid_state')
  })

  test('a finished step does not go back to running, and a repeat changes nothing', async () => {
    const h = harness()
    const job = await claimed(h)
    expect((await step(h, job, 1, 'success')).status).toBe(200)
    // It used to move a finished step back to running.
    const back = await step(h, job, 1, 'running')
    expect(back.status).toBe(409)
    // A runner's retry of the same report is answered, not refused, and
    // its lines are not written twice.
    const again = await step(h, job, 1, 'success')
    expect(again.status).toBe(200)
    const log = (
      await h.call(
        'GET',
        `${R}/pipelines/${job.run}/jobs/${job.job}/steps/1/log`,
      )
    ).json
    expect(JSON.stringify(log).split('step 1 success').length - 1).toBe(1)
  })
})

describe('automations', () => {
  test('a turned-off automation shows no next run', async () => {
    const h = harness()
    const made = await h.call('POST', `${R}/automations`, {
      body: {
        name: 'Weekly sweep',
        bot: 'triage-bot',
        triggers: ['schedule'],
        every: 'week',
        runtime: 'Claude Code',
        target: 'T3 Code',
        instructions: 'Look around.',
      },
    })
    expect(made.status).toBe(201)
    expect(made.json.next_run_at).not.toBeNull()
    const off = await h.call('PATCH', `${R}/automations/${made.json.id}`, {
      body: { enabled: false },
    })
    expect(off.status).toBe(200)
    expect(off.json.next_run_at).toBeNull()
  })
})

describe('device sign-in', () => {
  // The stores' own `get`, put back after each test.
  const stores = [MemoryOAuthState, ConvexOAuthState] as const
  const saved = stores.map((C) =>
    Object.getOwnPropertyDescriptor(C.prototype, 'get')!,
  )
  afterEach(() => {
    stores.forEach((C, i) =>
      Object.defineProperty(C.prototype, 'get', saved[i]),
    )
  })

  test('an approval that lands while a poll is under way is not lost', async () => {
    const now = clock()
    const h = harness({ now })
    const fetchRaw = (path: string, init: RequestInit = {}) =>
      h.api.fetch(
        new Request(`https://api.test/v1${path}`, {
          redirect: 'manual',
          ...init,
        }),
      )
    const form = (data: Record<string, string>) => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    })
    const client = (
      await (
        await fetchRaw('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Device CLI',
            redirect_uris: ['https://app.example.com/callback'],
          }),
        })
      ).json()
    ).client_id as string
    const code = await (
      await fetchRaw(
        '/oauth/device_authorization',
        form({ client_id: client, scope: 'repo:read' }),
      )
    ).json()
    const signIn = await fetchRaw('/oauth/session', {
      ...form({ handle: 'dana', return_to: '/' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://source.code',
      },
    })
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]
    const entry = await (
      await fetchRaw('/oauth/device', { headers: { cookie } })
    ).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(entry)![1]
    const approve = () =>
      fetchRaw('/oauth/device', {
        ...form({ csrf, user_code: code.user_code, decision: 'approve' }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
      })
    const poll = () =>
      fetchRaw(
        '/oauth/token',
        form({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: client,
        }),
      ).then((r) => r.json())

    // The person approves just after a poll has read the code as pending,
    // and before that poll is done with it.
    let armed = true
    for (const C of [MemoryOAuthState, ConvexOAuthState]) {
      const get = Object.getOwnPropertyDescriptor(C.prototype, 'get')!
        .value as (kind: string, key: string) => Promise<unknown>
      C.prototype.get = async function <T>(
        this: never,
        kind: never,
        key: string,
      ) {
        const value = await get.call(this, kind, key)
        if (armed && kind === 'device') {
          armed = false
          expect((await approve()).status).toBe(200)
        }
        return value as T
      } as never
    }
    now.advance(6000)
    expect((await poll()).error).toBe('authorization_pending')
    expect(armed).toBe(false)
    // The poll used to write the code back as it read it: pending, and the
    // approval was gone. The device must get its token.
    now.advance(6000)
    const token = await poll()
    expect(token.error).toBeUndefined()
    expect(token.access_token).toBeString()
  })
})
