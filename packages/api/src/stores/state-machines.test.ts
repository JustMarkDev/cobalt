import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test'
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { api as forge, internal } from '../../../../convex/_generated/api'
import schema from '../../../../convex/schema'
import { load } from '../../../../convex/seed'
import { createSampleApi } from '../index'
import { exportWorld } from '../seed-export'

/**
 * The races and stale states the Convex functions used to allow, each
 * reproduced against the functions themselves. The moves they may make are
 * in `lifecycles.ts`.
 */
const dir = new URL('../../../../convex/', import.meta.url).pathname

// A landing step that fails after it wrote something: its writes must not
// be kept. Armed per test; otherwise the real function.
const failAfterWrite = { armed: false }
const pipelinesPath = `${dir}forge/pipelines.ts`
// Taken before mocking: Bun updates the module's bindings in place.
const realPipelines = { ...(await import(pipelinesPath)) }
const realStart = realPipelines.startWorkflow as (
  ...a: Array<unknown>
) => Promise<unknown>
void mock.module(pipelinesPath, () => ({
  ...realPipelines,
  startWorkflow: async (...args: Array<unknown>) => {
    const r = await realStart(...args)
    if (failAfterWrite.armed)
      throw new ConvexError({
        code: 'internal',
        detail: 'Failed after a write.',
      })
    return r
  },
}))

const modules: Record<string, () => Promise<never>> = {}
for (const f of new Bun.Glob('**/*.{ts,js}').scanSync(dir))
  if (!f.endsWith('.d.ts') && !f.includes('.test.'))
    modules[`./${f}`] = () => import(`${dir}${f}`) as Promise<never>

const SECRET = 'test-secret-0123456789'
const START = new Date('2026-11-08T12:00:00Z').getTime()
const MINUTE = 60_000

beforeEach(() => setSystemTime(new Date(START)))
afterEach(() => {
  setSystemTime()
  failAfterWrite.armed = false
})

const SYSTEM = { subject: '~system', sx_cls: 'bot', sx_sys: 'true', sx_scp: '' }
const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms))

async function setup() {
  process.env.API_STORE_SECRET = SECRET
  const sample = createSampleApi({})
  const t = convexTest(schema, modules)
  await t.run((ctx) =>
    load(ctx, exportWorld(sample.domain, sample.domain.svc.auth as never)),
  )
  const sys = t.withIdentity(SYSTEM)
  const dana = (extra: Record<string, unknown> = {}) =>
    t.withIdentity({
      subject: 'dana',
      sx_tok: 'tok',
      sx_cls: 'human',
      sx_act: 'dana',
      sx_scp:
        'repo:read repo:write issues:read issues:write pulls:read pulls:write pulls:merge',
      ...extra,
    })
  const repo = await t.run(async (ctx) =>
    (await ctx.db.query('repos').collect()).find(
      (r) => r.owner === 'dana' && r.name === 'gitfs',
    ),
  )
  return { t, sys, dana, repo: repo! }
}

// ---- Webhook deliveries ---------------------------------------------------------

test('a late report from a claim that ran out does not undo a delivery', async () => {
  const { t, sys, repo } = await setup()
  const hookId = await t.run((ctx) =>
    ctx.db.insert('webhooks', {
      publicId: 'whk_test',
      repoId: repo._id,
      url: 'https://hooks.example.com/in',
      description: '',
      events: ['*'],
      active: true,
      disabledReason: null,
      secrets: [{ value: 'whsec_x', createdAt: START, expiresAt: null }],
      failures: 0,
      createdAt: START,
      updatedAt: START,
      version: 1,
      lastDelivery: null,
      nextSequence: 1,
    }),
  )
  await sys.mutation(forge.forge.webhooks.enqueueOne, {
    id: 'whk_test',
    event: JSON.stringify({ id: 'evt_1', type: 'issue.created' }),
    redeliveryOf: null,
  })
  const claim = async () =>
    JSON.parse(await sys.mutation(forge.forge.webhooks.claim, { limit: 1 }))[0]
  // Server A claims it, and goes quiet past its claim.
  const a = await claim()
  advance(2 * MINUTE)
  // Server B claims it again and delivers it.
  const b = await claim()
  expect(b.id).toBe(a.id)
  const report = (at: number, status: number) =>
    sys.mutation(forge.forge.webhooks.report, {
      id: a.id,
      at,
      status,
      error: null,
      ms: 5,
    })
  await report(b.at, 200)
  // A's answer arrives at last: the receiver said 410 Gone to it.
  await report(a.at, 410)
  const [d, h] = await t.run(async (ctx) => [
    (await ctx.db.query('webhookDeliveries').collect())[0],
    await ctx.db.get('webhooks', hookId),
  ])
  // It used to turn the delivered event into a failed one, count two
  // attempts, and turn the endpoint off.
  expect(d.state).toBe('succeeded')
  expect(d.attempts).toHaveLength(1)
  expect(h!.active).toBe(true)
})

// ---- Idempotency leases -------------------------------------------------------

test('a request whose key was taken over can no longer write, finish or give it up', async () => {
  const { t, dana } = await setup()
  const scope = 'dana@dana:tok'
  const begin = () =>
    t.mutation(forge.apiStores.beginIdempotency, {
      secret: SECRET,
      scope,
      key: 'k',
      fingerprint: 'f',
      ttlMs: 24 * 3_600_000,
    })
  const first = await begin()
  expect(first.state).toBe('new')
  const firstLease = first.state === 'new' ? first.lease : undefined
  // The first request goes quiet before writing; past its lease a retry
  // takes the key over.
  advance(11 * MINUTE)
  const second = await begin()
  expect(second.state).toBe('new')
  const secondLease = second.state === 'new' ? second.lease : undefined
  expect(secondLease).not.toBe(firstLease)

  const openIssue = (lease: string | undefined, title: string) =>
    dana({ sx_idem: JSON.stringify([scope, 'k', lease]) }).mutation(
      forge.forge.issues.create,
      { owner: 'dana', name: 'gitfs', title },
    )
  // The first comes back to life: its write used to go through, so the
  // request ran twice.
  await expect(openIssue(firstLease, 'From the stale request')).rejects.toThrow(
    /Another request now holds/,
  )
  // Nor may it give the key up from under the second, or answer for it.
  await t.mutation(forge.apiStores.abortIdempotency, {
    secret: SECRET,
    scope,
    key: 'k',
    lease: firstLease,
  })
  await t.mutation(forge.apiStores.completeIdempotency, {
    secret: SECRET,
    scope,
    key: 'k',
    lease: firstLease,
    status: 500,
    headers: '{}',
    body: 'stale',
  })
  expect((await begin()).state).toBe('in_progress')
  // The holder writes and finishes as ever.
  await openIssue(secondLease, 'From the holder')
  await t.mutation(forge.apiStores.completeIdempotency, {
    secret: SECRET,
    scope,
    key: 'k',
    lease: secondLease,
    status: 201,
    headers: '{}',
    body: 'ok',
  })
  const done = await begin()
  expect(done.state).toBe('replay')
  if (done.state === 'replay') expect(done.response.body).toBe('ok')
  const titles = await t.run(async (ctx) =>
    (await ctx.db.query('issues').collect()).map((i) => i.title),
  )
  expect(titles).toContain('From the holder')
  expect(titles).not.toContain('From the stale request')
})

// ---- Uploads ---------------------------------------------------------------------

async function uploaded(t: Awaited<ReturnType<typeof setup>>) {
  const u = JSON.parse(
    await t.sys.mutation(forge.forge.uploads.create, {
      owner: 'dana',
      filename: 'shot.png',
      contentType: 'image/png',
      size: 4,
      purpose: 'evidence',
    }),
  ) as { id: string }
  await t.sys.mutation(forge.forge.uploads.save, {
    id: u.id,
    state: 'uploaded',
    sha256: 'aa',
    attachedTo: null,
    attachedRepoId: null,
  })
  return u.id
}

test('one upload cannot be attached to two things', async () => {
  const s = await setup()
  const id = await uploaded(s)
  const add = (n: number) =>
    s.dana().mutation(forge.forge.issues.addEvidence, {
      owner: 'dana',
      name: 'gitfs',
      number: n,
      kind: 'image',
      caption: 'before',
      upload: { id, contentType: 'image/png', size: 4, sha256: 'aa' },
    })
  const issues = await s.t.run(async (ctx) =>
    (await ctx.db.query('issues').collect())
      .filter((i) => i.repoId === s.repo._id)
      .map((i) => i.number),
  )
  // Two requests, each having seen the upload unattached.
  await add(issues[0])
  // The second used to be kept too: one file shown on two issues.
  await expect(add(issues[1])).rejects.toThrow(/already attached/)
  const evidence = await s.t.run((ctx) =>
    ctx.db.query('issueEvidence').collect(),
  )
  expect(evidence.filter((e) => e.upload.id === id)).toHaveLength(1)
})

test('saving an upload never re-points it or takes its file away', async () => {
  const s = await setup()
  const id = await uploaded(s)
  const save = (fields: {
    state: 'pending' | 'uploaded'
    sha256: string | null
    attachedTo: string | null
  }) =>
    s.sys.mutation(forge.forge.uploads.save, {
      id,
      ...fields,
      attachedRepoId: fields.attachedTo ? 'rep_x' : null,
    })
  await save({ state: 'uploaded', sha256: 'aa', attachedTo: 'dana/gitfs' })
  // A request holding an older copy saves it as it saw it: it used to win.
  await expect(
    save({ state: 'uploaded', sha256: 'aa', attachedTo: 'dana/notes' }),
  ).rejects.toThrow(/already attached/)
  await expect(
    save({ state: 'pending', sha256: null, attachedTo: null }),
  ).rejects.toThrow(/cannot become pending/)
  const u = await s.t.run(async (ctx) =>
    (await ctx.db.query('uploads').collect()).find((x) => x.publicId === id),
  )
  expect(u).toMatchObject({ state: 'uploaded', attachedTo: 'dana/gitfs' })
})

test('of two requests sending one upload its file, one is told no before keeping bytes', async () => {
  const s = await setup()
  const u = JSON.parse(
    await s.sys.mutation(forge.forge.uploads.create, {
      owner: 'dana',
      filename: 'shot.png',
      contentType: 'image/png',
      size: 4,
      purpose: 'evidence',
    }),
  ) as { id: string }
  const receive = (sha256: string) =>
    s.sys
      .mutation(forge.forge.uploads.receive, { id: u.id, sha256 })
      .then((r) => JSON.parse(r) as string | null)
  const [a, b] = await Promise.all([receive('aa'), receive('bb')])
  expect([a, b].filter((x) => x === null)).toHaveLength(1)
  expect([a, b].find((x) => x !== null)).toContain('already has its file')
})

// ---- Agent runs --------------------------------------------------------------------

test('runs whose token ran out do not hide the live ones from the limit', async () => {
  const s = await setup()
  const run = (expires: number) => ({
    publicId: `run_${Math.random().toString(36).slice(2)}`,
    repoId: s.repo._id,
    repo: 'dana/gitfs',
    task: 'old',
    state: 'running' as const,
    handle: 'dana',
    change: null,
    scopes: ['repo:read'],
    tokenId: 'tok_none',
    notes: [],
    summary: null,
    started: expires - 30 * MINUTE,
    expires,
    finished: null,
    version: 1,
  })
  await s.t.run(async (ctx) => {
    // A hundred runs nobody finished, from before expiry was written.
    for (let i = 0; i < 100; i++)
      await ctx.db.insert('runs', run(START - 60 * MINUTE))
    // And twenty going now.
    for (let i = 0; i < 20; i++)
      await ctx.db.insert('runs', run(START + 60 * MINUTE))
  })
  // It used to look at the oldest hundred, see none live, and allow a 21st.
  await expect(
    s.dana().mutation(forge.forge.runs.start, {
      owner: 'dana',
      name: 'gitfs',
      task: 'one too many',
      ttl_minutes: 30,
    }),
  ).rejects.toThrow(/runs going at once/)
})

test('a run is written expired when its token runs out', async () => {
  const s = await setup()
  const started = JSON.parse(
    await s.dana().mutation(forge.forge.runs.start, {
      owner: 'dana',
      name: 'gitfs',
      task: 'Left alone',
      ttl_minutes: 30,
    }),
  ) as { run: { id: string } }
  const row = async () =>
    (await s.t.run((ctx) => ctx.db.query('runs').collect())).find(
      (r) => r.publicId === started.run.id,
    )!
  const scheduled = await s.t.run((ctx) =>
    ctx.db.system.query('_scheduled_functions').collect(),
  )
  // Its expiry is booked for its deadline when it starts.
  const at = (await row()).expires
  expect(
    scheduled.some(
      (j) =>
        j.name.includes('runs') &&
        j.name.includes('expire') &&
        j.scheduledTime === at,
    ),
  ).toBe(true)
  advance(31 * MINUTE)
  await s.t.mutation(internal.forge.runs.expire, { run: (await row())._id })
  const after = await row()
  // It used to stay `running` in the database for a week.
  expect(after.state).toBe('expired')
  expect(after.finished).toBe(after.expires)
  const token = await s.t.run(async (ctx) =>
    (await ctx.db.query('tokens').collect()).find(
      (x) => x.publicId === after.tokenId,
    ),
  )
  expect(token?.revokedAt).not.toBeNull()
})

// ---- Automations ---------------------------------------------------------------------

test('turned-off automations never keep a due one from firing', async () => {
  const s = await setup()
  const automation = (n: number, enabled: boolean) => ({
    repoId: s.repo._id,
    publicId: `aut_${enabled ? 'on' : 'off'}${n}`,
    name: `${enabled ? 'On' : 'Off'} ${n}`,
    bot: 'triage-bot',
    triggers: ['schedule'],
    runtime: 'Claude Code',
    target: 'T3 Code',
    instructions: 'Look.',
    enabled,
    triggered: 0,
    lastTriggered: null,
    lastRun: null,
    every: 'hour',
    lastScheduled: START - 2 * 3_600_000,
    // Turned off before the schedule was cleared on turning off.
    nextRun: START - 3_600_000 - (enabled ? 0 : 1000),
    created: START - 3 * 3_600_000,
    version: 1,
  })
  await s.t.run(async (ctx) => {
    for (let i = 0; i < 500; i++)
      await ctx.db.insert('automations', automation(i, false))
    await ctx.db.insert('automations', automation(0, true))
  })
  const tick = () => s.t.mutation(internal.forge.automations.tickSchedules, {})
  // It used to read the first 500 due, skip every one, and never get here.
  let fired = await tick()
  if (fired === 0) fired = await tick()
  expect(fired).toBe(1)
  const all = await s.t.run((ctx) => ctx.db.query('automations').collect())
  expect(all.find((a) => a.publicId === 'aut_on0')!.lastScheduled).toBe(START)
  // And the turned-off ones left the queue.
  expect(
    all.filter(
      (a) =>
        !a.enabled && a.nextRun !== null && a.publicId.startsWith('aut_off'),
    ),
  ).toHaveLength(0)
})

// ---- Landing steps ---------------------------------------------------------------------

async function landingStep(s: Awaited<ReturnType<typeof setup>>) {
  const operation = await s.t.run((ctx) =>
    ctx.db.insert('operations', {
      publicId: 'op_test',
      kind: 'change.land',
      repoId: s.repo.publicId,
      state: 'queued',
      done: 0,
      total: 1,
      result: null,
      error: null,
      created: START,
      finished: null,
      steps: JSON.stringify([
        {
          kind: 'run_pipeline',
          target: 'build',
          state: 'pending',
          detail: '',
          finished: null,
        },
      ]),
    }),
  )
  const args = {
    operation,
    repo: s.repo._id,
    trees: [],
    as: {
      handle: 'dana',
      actingAs: 'dana',
      class: 'human' as const,
      scopes: ['repo:read', 'repo:write'],
      repos: null,
    },
    by: { id: 'acc_dana', handle: 'dana', class: 'human' as const },
  }
  const step = (i: number) =>
    s.t.mutation(internal.forge.stackLanding.step, { ...args, i })
  const op = () => s.t.run((ctx) => ctx.db.get('operations', operation))
  const countRuns = () =>
    s.t.run(
      async (ctx) => (await ctx.db.query('pipelineRuns').collect()).length,
    )
  return { step, op, countRuns }
}

test('a landing step that succeeds keeps its writes, and runs once', async () => {
  const s = await setup()
  const l = await landingStep(s)
  const before = await l.countRuns()
  await l.step(0)
  expect(await l.countRuns()).toBe(before + 1)
  expect((await l.op())!.state).toBe('running')
  // Run again (as a duplicate schedule would), it does nothing.
  await l.step(0)
  expect(await l.countRuns()).toBe(before + 1)
  await l.step(1)
  expect((await l.op())!.state).toBe('succeeded')
  // Over is over.
  await l.step(1)
  expect((await l.op())!.state).toBe('succeeded')
})

test('a landing step that fails keeps none of its writes', async () => {
  const s = await setup()
  const l = await landingStep(s)
  const before = await l.countRuns()
  failAfterWrite.armed = true
  await l.step(0)
  const op = (await l.op())!
  expect(op.state).toBe('failed')
  const [shown] = JSON.parse(op.steps!)
  expect(shown).toMatchObject({
    state: 'failed',
    detail: 'Failed after a write.',
  })
  // The step started a pipeline run, then failed: that run used to be kept,
  // though the operation says the step did not happen.
  expect(await l.countRuns()).toBe(before)
})
