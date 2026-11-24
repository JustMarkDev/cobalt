import { describe, expect, test } from 'bun:test'
import {
  canMove,
  expireWait,
  pipelineDone,
  pipelineLifecycle,
  pipelineStepLifecycle,
  resumeStep,
  waitStep,
} from './lifecycles'
import { sampleTokens } from './sample'
import { clock, harness } from './testing'

const R = '/repos/dana/gitfs'
const DAY = 86_400_000

async function running(h: ReturnType<typeof harness>) {
  const run = (
    await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
  ).json
  let job: any
  for (let i = 0; i < 30 && !job; i++) {
    const c = (
      await h.call('POST', `${R}/pipelines/claim`, { body: { runner: 'r1' } })
    ).json
    if (c?.run === run.number) job = c
  }
  expect(job).toBeDefined()
  const step = `${R}/pipelines/${job.run}/jobs/${job.job}/steps/1`
  expect(
    (await h.call('POST', step, { body: { status: 'running' } })).status,
  ).toBe(200)
  return { run: job.run as number, job: job.job as number, step }
}

describe('the moves', () => {
  test('a run and a step wait only from running, and leave waiting forward', () => {
    expect(canMove(pipelineLifecycle, 'running', 'waiting')).toBe(true)
    expect(canMove(pipelineLifecycle, 'queued', 'waiting')).toBe(false)
    expect(canMove(pipelineLifecycle, 'waiting', 'running')).toBe(true)
    expect(canMove(pipelineLifecycle, 'waiting', 'canceled')).toBe(true)
    expect(canMove(pipelineLifecycle, 'waiting', 'failure')).toBe(true)
    expect(canMove(pipelineLifecycle, 'waiting', 'success')).toBe(false)
    expect(canMove(pipelineLifecycle, 'waiting', 'queued')).toBe(false)
    expect(canMove(pipelineStepLifecycle, 'running', 'waiting')).toBe(true)
    expect(canMove(pipelineStepLifecycle, 'queued', 'waiting')).toBe(false)
    for (const to of ['running', 'success', 'failure', 'canceled'] as const)
      expect(canMove(pipelineStepLifecycle, 'waiting', to)).toBe(true)
    expect(canMove(pipelineStepLifecycle, 'waiting', 'skipped')).toBe(false)
    expect(canMove(pipelineStepLifecycle, 'success', 'waiting')).toBe(false)
    expect(pipelineDone('waiting')).toBe(false)
  })

  test('only a running step waits; only a waiting one resumes; a late timer does nothing', () => {
    const run = () => ({
      number: 3,
      status: 'running',
      finished: null as number | null,
      jobs: [
        {
          status: 'running',
          duration: 0,
          steps: [
            { status: 'running', duration: 0 },
            { status: 'queued', duration: 0 },
          ],
        },
      ],
    })
    const w = {
      kind: 'person' as const,
      reason: 'r',
      target: null,
      expires: 10,
    }
    const queued = run()
    expect(waitStep(queued, 1, 2, w)?.refusal).toContain('only a running step')
    const r = run()
    expect(waitStep(r, 1, 1, w)).toBeNull()
    expect(r.status).toBe('waiting')
    expect(r.jobs[0].status).toBe('waiting')
    expect(resumeStep(run(), 1, 1, 'success', 5)?.refusal).toContain(
      'only a waiting step',
    )
    expect(expireWait(r, 1, 1, 9, 20)).toBe(false)
    expect(resumeStep(r, 1, 1, 'success', 5)).toBeNull()
    expect(r.status).toBe('running')
    expect(expireWait(r, 1, 1, 10, 20)).toBe(false)
  })
})

describe('waiting and resuming', () => {
  test('wait, then resume with success: the job carries on', async () => {
    const h = harness()
    const { run, job, step } = await running(h)
    const waited = await h.call('POST', `${step}/wait`, {
      body: {
        kind: 'person',
        reason: 'Check the release notes',
        target: 'hollis',
      },
    })
    expect(waited.status).toBe(200)
    expect(waited.json.status).toBe('waiting')
    const j = waited.json.jobs[job - 1]
    expect(j.status).toBe('waiting')
    expect(j.wait).toMatchObject({
      kind: 'person',
      reason: 'Check the release notes',
      target: 'hollis',
    })
    expect(Date.parse(j.wait.expires_at) - h.now()).toBe(7 * DAY)
    expect(j.steps[0].wait.target).toBe('hollis')
    expect(
      (await h.call('POST', step, { body: { status: 'success' } })).status,
    ).toBe(409)
    const resumed = await h.call('POST', `${step}/resume`, {
      body: { status: 'success', summary: 'docs updated' },
    })
    expect(resumed.status).toBe(200)
    expect(resumed.json.status).toBe('running')
    expect(resumed.json.jobs[job - 1].status).toBe('running')
    expect(resumed.json.jobs[job - 1].steps[0]).toMatchObject({
      status: 'success',
      wait: null,
    })
    const log = (await h.call('GET', `${step}/log`)).json
    expect(JSON.stringify(log)).toContain('docs updated')
    const next = await h.call(
      'POST',
      `${R}/pipelines/${run}/jobs/${job}/steps/2`,
      { body: { status: 'running' } },
    )
    expect(next.status).toBe(200)
  })

  test('wait, then resume with failure: the rest of the job is skipped', async () => {
    const h = harness()
    const { job, step } = await running(h)
    await h.call('POST', `${step}/wait`, {
      body: { kind: 'agent', reason: 'Waiting for the agent to fix the docs' },
    })
    const resumed = await h.call('POST', `${step}/resume`, {
      body: { status: 'failure', summary: 'the agent gave up' },
    })
    expect(resumed.status).toBe(200)
    const j = resumed.json.jobs[job - 1]
    expect(j.status).toBe('failure')
    expect(j.steps[0].status).toBe('failure')
    expect(j.steps.slice(1).every((s: any) => s.status === 'skipped')).toBe(
      true,
    )
    expect(resumed.json.annotations.at(-1).text).toBe('the agent gave up')
  })

  test('a wait nobody answers fails the step and the run', async () => {
    const now = clock()
    const h = harness({ now })
    const { run, job, step } = await running(h)
    await h.call('POST', `${step}/wait`, {
      body: {
        kind: 'approval',
        reason: 'Sign off the migration',
        expires_at: new Date(now() + DAY).toISOString(),
      },
    })
    now.advance(DAY + 60_000)
    await h.call('POST', `${R}/pipelines/claim`, { body: { runner: 'r9' } })
    const after = (await h.call('GET', `${R}/pipelines/${run}`)).json
    expect(after.status).toBe('failure')
    expect(after.finished_at).not.toBeNull()
    expect(after.jobs[job - 1].steps[0].status).toBe('failure')
    expect(after.annotations.at(-1).text).toContain('Sign off the migration')
    expect(
      (await h.call('POST', `${step}/resume`, { body: { status: 'success' } }))
        .status,
    ).toBe(409)
  })

  test('a wait ends within 30 days', async () => {
    const h = harness()
    const { step } = await running(h)
    const far = await h.call('POST', `${step}/wait`, {
      body: {
        kind: 'person',
        reason: 'x',
        expires_at: new Date(h.now() + 31 * DAY).toISOString(),
      },
    })
    expect(far.status).toBe(400)
    expect(far.json.errors[0].pointer).toBe('/body/expires_at')
  })

  test('cancel while waiting', async () => {
    const h = harness()
    const { run, job, step } = await running(h)
    await h.call('POST', `${step}/wait`, {
      body: { kind: 'person', reason: 'Look at this' },
    })
    const c = await h.call('POST', `${R}/pipelines/${run}/cancel`)
    expect(c.status).toBe(200)
    expect(c.json.status).toBe('canceled')
    expect(c.json.jobs[job - 1].steps[0]).toMatchObject({
      status: 'canceled',
      wait: null,
    })
  })

  test('a waiting job is not claimed again', async () => {
    const h = harness()
    const { run, step } = await running(h)
    await h.call('POST', `${step}/wait`, {
      body: { kind: 'person', reason: 'Look at this' },
    })
    for (let i = 0; i < 30; i++) {
      const c = await h.call('POST', `${R}/pipelines/claim`, {
        body: { runner: 'r2' },
      })
      if (c.status === 204) break
      expect(c.json.run === run && c.json.job === 1).toBe(false)
    }
  })

  test('a reader sees the wait; only a writer waits or resumes', async () => {
    const h = harness()
    const { run, step } = await running(h)
    expect(
      (
        await h.call('POST', `${step}/wait`, {
          token: sampleTokens.stranger,
          body: { kind: 'person', reason: 'x' },
        })
      ).status,
    ).toBe(403)
    await h.call('POST', `${step}/wait`, {
      body: { kind: 'person', reason: 'Look at this', target: 'hollis' },
    })
    const seen = await h.call('GET', `${R}/pipelines/${run}`, { token: null })
    expect(seen.status).toBe(200)
    expect(seen.json.status).toBe('waiting')
    expect(
      (
        await h.call('POST', `${step}/resume`, {
          token: sampleTokens.stranger,
          body: { status: 'success' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await h.call('POST', `${step}/resume`, {
          token: sampleTokens.hollis,
          body: { status: 'success' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await h.call('POST', `${step}/resume`, { body: { status: 'success' } }))
        .status,
    ).toBe(200)
  })

  test('the person it waits on is told, in their inbox', async () => {
    const h = harness()
    const { run, step } = await running(h)
    await h.call('POST', `${step}/wait`, {
      body: { kind: 'person', reason: 'Approve the deploy', target: 'hollis' },
    })
    const n = (
      await h.call('GET', '/notifications?kind=handoff', {
        token: sampleTokens.hollis,
      })
    ).json
    expect(n.data[0].title).toContain('Approve the deploy')
    expect(n.data[0].html_url).toContain(`n=${run}`)
    const inbox = (
      await h.call('GET', '/inbox', { token: sampleTokens.hollis })
    ).json
    const item = inbox.items.find((x: any) => x.kind === 'pipeline_waiting')
    expect(item).toMatchObject({
      severity: 'handoff',
      action: 'resume',
      subject: { type: 'run', number: run },
    })
    const hers = (await h.call('GET', '/inbox')).json
    expect(
      hers.items.some(
        (x: any) => x.kind === 'pipeline_waiting' && x.subject.number === run,
      ),
    ).toBe(false)
  })
})
