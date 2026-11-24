import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { clock, harness, withRunsOn } from './testing'

const R = '/repos/dana/gitfs'

describe('runners', () => {
  test('start a workflow, claim its job, report every step', async () => {
    const h = harness()
    const run = await h.call('POST', `${R}/pipelines`, {
      body: { workflow: 'build' },
    })
    expect(run.status).toBe(201)
    expect(run.json.status).toBe('queued')
    // Older queued runs may exist: claim until we get this one's job.
    let job
    for (let i = 0; i < 20; i++) {
      const c = await h.call('POST', `${R}/pipelines/claim`, {
        body: { runner: 'test-runner' },
      })
      expect(c.status).toBe(200)
      if (c.json.run === run.json.number) {
        job = c.json
        break
      }
    }
    expect(job).toBeDefined()
    expect(job.object).toBe('pipeline_job')
    let last
    for (const s of job.steps)
      last = await h.call(
        'POST',
        `${R}/pipelines/${job.run}/jobs/${job.job}/steps/${s.number}`,
        {
          body: {
            status: 'success',
            lines: [{ text: `ran ${s.name}`, level: 'ok' }],
            duration_ms: 100,
          },
        },
      )
    const after = (await h.call('GET', `${R}/pipelines/${job.run}`)).json
    expect(after.jobs[job.job - 1].status).toBe('success')
    expect(after.jobs[job.job - 1].runner).toBe('test-runner')
    expect(last?.status).toBe(200)
    const log = (
      await h.call(
        'GET',
        `${R}/pipelines/${job.run}/jobs/${job.job}/steps/1/log`,
      )
    ).json
    expect(JSON.stringify(log)).toContain(`ran ${job.steps[0].name}`)
  })

  test('a failed step skips the rest and fails the job', async () => {
    const h = harness()
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    let job
    for (let i = 0; i < 20 && !job; i++) {
      const c = (
        await h.call('POST', `${R}/pipelines/claim`, { body: { runner: 'r' } })
      ).json
      if (c.run === run.number) job = c
    }
    const out = await h.call(
      'POST',
      `${R}/pipelines/${job.run}/jobs/${job.job}/steps/1`,
      {
        body: {
          status: 'failure',
          lines: [{ text: 'error: it broke', level: 'error' }],
        },
      },
    )
    const j = out.json.jobs[job.job - 1]
    expect(j.status).toBe('failure')
    expect(j.steps[1].status).toBe('skipped')
    expect(out.json.annotations.at(-1).text).toBe('error: it broke')
  })

  test('nothing to do answers 204; a reader cannot claim', async () => {
    const h = harness()
    for (let i = 0; i < 50; i++) {
      const c = await h.call('POST', `${R}/pipelines/claim`, {
        body: { runner: 'r' },
      })
      if (c.status === 204) break
    }
    expect(
      (await h.call('POST', `${R}/pipelines/claim`, { body: { runner: 'r' } }))
        .status,
    ).toBe(204)
    expect(
      (
        await h.call('POST', `${R}/pipelines/claim`, {
          token: sampleTokens.stranger,
          body: { runner: 'r' },
        })
      ).status,
    ).toBe(403)
  })
})

// ---- registered runners ------------------------------------------------------

async function register(
  h: ReturnType<typeof harness>,
  body: Record<string, unknown>,
) {
  const r = await h.call('POST', '/runners', { body })
  expect(r.status).toBe(201)
  return r.json
}

/** Every queued job the runner may take, until it gets this run's. */
async function claimRun(
  h: ReturnType<typeof harness>,
  secret: string,
  run: number,
) {
  for (let i = 0; i < 30; i++) {
    const c = await h.call('POST', '/runners/claim', { token: secret })
    if (c.status === 204) return null
    if (c.json.run === run) return c.json
    // Something older: finish it, so the next claim moves on.
    for (const s of c.json.steps)
      await h.call('POST', '/runners/report', {
        token: secret,
        body: {
          repo: 'dana/gitfs',
          run: c.json.run,
          job: c.json.job,
          step: s.number,
          status: 'success',
        },
      })
  }
  return null
}

describe('registered runners', () => {
  test('the secret is shown once, and never listed again', async () => {
    const h = harness()
    const made = await register(h, {
      name: 'mac-mini',
      labels: ['macOS', 'arm64', 'xcode-16'],
    })
    expect(made.secret).toMatch(/^cbr_/)
    expect(made.labels).toEqual(['macos', 'arm64', 'xcode-16'])
    expect(made.kind).toBe('self-hosted')
    expect(made.provider).toBeNull()
    expect(made.status).toBe('offline')
    const list = (await h.call('GET', '/runners')).json
    expect(list.data.map((r: any) => r.id)).toContain(made.id)
    expect(list.data.every((r: any) => r.secret === null)).toBe(true)
    expect((await h.call('GET', `/runners/${made.id}`)).json.secret).toBeNull()
    // Runner tokens are not personal tokens.
    const tokens = (await h.call('GET', '/tokens')).json.data
    expect(tokens.some((t: any) => t.prefix.startsWith('cbr_'))).toBe(false)
    // A heartbeat brings it online.
    const beat = await h.call('POST', '/runners/heartbeat', {
      token: made.secret,
    })
    expect(beat.status).toBe(200)
    expect(beat.json.status).toBe('online')
  })

  test('a runner token reads its repositories and does nothing else', async () => {
    const h = harness()
    const made = await register(h, { name: 'linux-1', repos: ['dana/gitfs'] })
    expect(
      (await h.call('GET', `${R}/git/commits?limit=1`, { token: made.secret }))
        .status,
    ).toBe(200)
    // It cannot open a change, read issues, manage runners or make tokens.
    expect(
      (
        await h.call('POST', `${R}/issues`, {
          token: made.secret,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await h.call('GET', '/runners', { token: made.secret })).status,
    ).toBe(403)
    expect(
      (
        await h.call('POST', `${R}/pipelines/claim`, {
          token: made.secret,
          body: { runner: 'x' },
        })
      ).status,
    ).toBe(403)
    // And a person's token cannot act as a runner.
    expect((await h.call('POST', '/runners/claim')).status).toBe(403)
  })

  test('revoking a runner stops its token on the next request', async () => {
    const h = harness()
    const made = await register(h, { name: 'gone-soon' })
    expect(
      (await h.call('POST', '/runners/heartbeat', { token: made.secret }))
        .status,
    ).toBe(200)
    const del = await h.call('DELETE', `/runners/${made.id}`)
    expect(del.status).toBe(200)
    expect(del.json.status).toBe('disabled')
    const after = await h.call('POST', '/runners/heartbeat', {
      token: made.secret,
    })
    expect(after.status).toBe(401)
    expect(after.json.code).toBe('token_revoked')
  })

  test('labels match as a subset, ignoring case', async () => {
    const h = await withRunsOn(['MacOS', 'xcode-16'])
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    expect(run.jobs[0].runs_on).toEqual(['macos', 'xcode-16'])
    const linux = await register(h, { name: 'linux', labels: ['linux'] })
    const mac = await register(h, {
      name: 'mac',
      labels: ['macos', 'arm64', 'XCODE-16'],
    })
    expect(await claimRun(h, linux.secret, run.number)).toBeNull()
    const job = await claimRun(h, mac.secret, run.number)
    expect(job).not.toBeNull()
    expect(job.runs_on).toEqual(['macos', 'xcode-16'])
    expect(job.runner_id).toBe(mac.id)
    expect(job.lease_expires_at).not.toBeNull()
    const shown = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(shown.jobs[job.job - 1].runner).toBe('mac')
    expect(shown.jobs[job.job - 1].runner_id).toBe(mac.id)
  })

  test('runs-on reads a string and a list', async () => {
    const { runsOnOf } = await import('./workflow')
    expect(
      runsOnOf(
        'jobs:\n  a:\n    runs-on: Linux\n  b:\n    runs-on: [macos, ARM64]\n  c: {}\n',
      ).jobs,
    ).toEqual(
      new Map([
        ['a', ['linux']],
        ['b', ['macos', 'arm64']],
        ['c', []],
      ]),
    )
    const odd = runsOnOf('jobs:\n  a:\n    runs-on: { group: big }\n')
    expect(odd.jobs.get('a')).toEqual([])
    expect(odd.warnings[0]).toContain('runs-on')
  })

  test('a job with no matching runner stays queued and says why', async () => {
    const h = await withRunsOn(['macos', 'xcode-16'])
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    expect(run.jobs[0].waiting_for_labels).toEqual(['macos', 'xcode-16'])
    await register(h, { name: 'linux', labels: ['linux'] })
    const still = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(still.jobs[0].status).toBe('queued')
    expect(still.jobs[0].waiting_for_labels).toEqual(['macos', 'xcode-16'])
    // A named runner without labels does not take it either.
    for (let i = 0; i < 30; i++) {
      const c = await h.call('POST', `${R}/pipelines/claim`, {
        body: { runner: 'old' },
      })
      if (c.status === 204) break
      expect(c.json.run).not.toBe(run.number)
    }
    await register(h, { name: 'mac', labels: ['macos', 'xcode-16'] })
    const now = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(now.jobs[0].waiting_for_labels).toBeNull()
  })

  test('a runner does not claim from a repository it is not assigned', async () => {
    const h = await withRunsOn('linux')
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const other = await register(h, {
      name: 'only-tinyqueue',
      labels: ['linux'],
      repos: ['dana/tinyqueue'],
    })
    expect(await claimRun(h, other.secret, run.number)).toBeNull()
  })

  test("a runner does not claim another account's job", async () => {
    const h = await withRunsOn('linux')
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const org = await register(h, {
      name: 'northwind-linux',
      account: 'northwind',
      labels: ['linux'],
    })
    expect(org.account).toBe('northwind')
    expect(await claimRun(h, org.secret, run.number)).toBeNull()
    // Nor can it read a private repository of the person who made it.
    expect(
      (await h.call('GET', '/repos/dana/notes', { token: org.secret })).status,
    ).toBe(404)
    // And it cannot be registered for an account you only belong to.
    const member = await h.call('POST', '/runners', {
      body: { name: 'x', account: 'lumen-studio' },
    })
    expect(member.status).toBe(403)
  })

  test('the concurrency limit answers 204', async () => {
    const h = await withRunsOn('linux')
    await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    const one = await register(h, {
      name: 'single',
      labels: ['linux'],
      concurrency: 1,
    })
    const first = await h.call('POST', '/runners/claim', { token: one.secret })
    expect(first.status).toBe(200)
    const second = await h.call('POST', '/runners/claim', { token: one.secret })
    expect(second.status).toBe(204)
    const jobs = (
      await h.call('GET', `/runners/${one.id}/jobs`, { token: one.secret })
    ).json
    expect(jobs.data).toHaveLength(1)
    expect(jobs.data[0]).toMatchObject({
      run: first.json.run,
      status: 'running',
    })
  })

  test('a heartbeat extends the lease; a lease that runs out requeues the job', async () => {
    const now = clock()
    const h = await withRunsOn('linux', now)
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const a = await register(h, { name: 'a', labels: ['linux'] })
    const job = await claimRun(h, a.secret, run.number)
    const leased = Date.parse(job.lease_expires_at)
    now.advance(10 * 60_000)
    await h.call('POST', '/runners/heartbeat', { token: a.secret })
    const extended = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
      .jobs[job.job - 1]
    expect(Date.parse(extended.lease_expires_at)).toBeGreaterThan(leased)
    // Silent past its lease: the next runner gets the job.
    now.advance(16 * 60_000)
    const b = await register(h, { name: 'b', labels: ['linux'] })
    const again = await claimRun(h, b.secret, run.number)
    expect(again).not.toBeNull()
    expect(again.job).toBe(job.job)
    expect(again.runner_id).toBe(b.id)
    const shown = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(
      shown.annotations.some((x: any) => x.text.includes('Runner a')),
    ).toBe(true)
    // The first runner may no longer report it.
    const late = await h.call('POST', '/runners/report', {
      token: a.secret,
      body: {
        repo: 'dana/gitfs',
        run: run.number,
        job: job.job,
        step: 1,
        status: 'success',
      },
    })
    expect(late.status).toBe(403)
  })

  test('a hosted runner registers and works the same way', async () => {
    const h = await withRunsOn('blacksmith-4vcpu-ubuntu-2404')
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const bs = await register(h, {
      name: 'blacksmith',
      kind: 'hosted',
      provider: 'blacksmith',
      labels: ['blacksmith-4vcpu-ubuntu-2404', 'linux'],
      concurrency: 4,
    })
    expect(bs.kind).toBe('hosted')
    expect(bs.provider).toBe('blacksmith')
    const job = await claimRun(h, bs.secret, run.number)
    expect(job).not.toBeNull()
    let last
    for (const s of job.steps)
      last = await h.call('POST', '/runners/report', {
        token: bs.secret,
        body: {
          repo: 'dana/gitfs',
          run: job.run,
          job: job.job,
          step: s.number,
          status: 'success',
          lines: [{ text: `ran ${s.name}`, level: 'ok' }],
          duration_ms: 10,
        },
      })
    expect(last?.status).toBe(200)
    expect(last?.json.jobs[job.job - 1].status).toBe('success')
    expect(last?.json.jobs[job.job - 1].lease_expires_at).toBeNull()
  })

  test('labels and repositories are checked', async () => {
    const h = harness()
    const bad = await h.call('POST', '/runners', {
      body: { name: 'x', labels: ['has space'] },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.errors[0].pointer).toBe('/body/labels')
    const other = await h.call('POST', '/runners', {
      body: { name: 'x', repos: ['northwind/atlas'] },
    })
    expect([400, 404]).toContain(other.status)
    await register(h, { name: 'dup' })
    const dup = await h.call('POST', '/runners', { body: { name: 'DUP' } })
    expect(dup.status).toBe(400)
    expect(dup.json.errors[0].pointer).toBe('/body/name')
  })

  test('a change of labels is a PATCH; a revoked runner cannot be changed', async () => {
    const h = harness()
    const made = await register(h, { name: 'm', labels: ['a'] })
    const patched = await h.call('PATCH', `/runners/${made.id}`, {
      body: { labels: ['B', 'c'], concurrency: 2 },
    })
    expect(patched.status).toBe(200)
    expect(patched.json.labels).toEqual(['b', 'c'])
    expect(patched.json.concurrency).toBe(2)
    await h.call('DELETE', `/runners/${made.id}`)
    expect(
      (
        await h.call('PATCH', `/runners/${made.id}`, {
          body: { labels: ['x'] },
        })
      ).status,
    ).toBe(409)
    // Someone outside the account does not see it at all.
    expect(
      (
        await h.call('GET', `/runners/${made.id}`, {
          token: sampleTokens.stranger,
        })
      ).status,
    ).toBe(404)
  })
})

describe('a runner pauses a step it is running', () => {
  test('with its own token, only on a job it holds; a person resumes it', async () => {
    const now = clock()
    const h = await withRunsOn('linux', now)
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const a = await register(h, { name: 'a', labels: ['linux'] })
    const b = await register(h, { name: 'b', labels: ['linux'] })
    const job = await claimRun(h, a.secret, run.number)
    const at = { repo: 'dana/gitfs', run: run.number, job: job.job, step: 1 }
    await h.call('POST', '/runners/report', {
      token: a.secret,
      body: { ...at, status: 'running' },
    })
    const wait = {
      ...at,
      kind: 'approval',
      reason: 'Sign off the release',
      target: 'hollis',
    }
    // Another runner cannot pause a job it does not hold.
    const theirs = await h.call('POST', '/runners/wait', {
      token: b.secret,
      body: wait,
    })
    expect(theirs.status).toBe(403)
    // Nor can a person's token use the runner's door.
    expect((await h.call('POST', '/runners/wait', { body: wait })).status).toBe(
      403,
    )
    const paused = await h.call('POST', '/runners/wait', {
      token: a.secret,
      body: wait,
    })
    expect(paused.status).toBe(200)
    expect(paused.json.status).toBe('waiting')
    const j = paused.json.jobs[job.job - 1]
    expect(j).toMatchObject({ status: 'waiting', runner_id: a.id })
    expect(j.wait.target).toBe('hollis')
    // A waiting job has no lease to run out: it stays with its runner.
    now.advance(20 * 60_000)
    await h.call('POST', '/runners/heartbeat', { token: b.secret })
    const held = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(held.jobs[job.job - 1]).toMatchObject({
      status: 'waiting',
      runner_id: a.id,
    })
    // The runner cannot answer its own wait; a login with repo:write can.
    expect(
      (
        await h.call(
          'POST',
          `${R}/pipelines/${run.number}/jobs/${job.job}/steps/1/resume`,
          { token: a.secret, body: { status: 'success' } },
        )
      ).status,
    ).toBe(403)
    const resumed = await h.call(
      'POST',
      `${R}/pipelines/${run.number}/jobs/${job.job}/steps/1/resume`,
      { body: { status: 'success', summary: 'Signed off.' } },
    )
    expect(resumed.status).toBe(200)
    expect(resumed.json.jobs[job.job - 1].lease_expires_at).not.toBeNull()
    // The runner carries on with the next step.
    const next = await h.call('POST', '/runners/report', {
      token: a.secret,
      body: { ...at, step: 2, status: 'running' },
    })
    expect(next.status).toBe(200)
  })
})
