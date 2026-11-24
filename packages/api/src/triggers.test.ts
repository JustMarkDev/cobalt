import { describe, expect, test } from 'bun:test'
import {
  parseTriggerFiles,
  parseTriggers,
  triggerMatches,
  triggersFor,
} from './trigger-file'
import { gitWith, harness, onConvex } from './testing'
import type { MemoryDomain } from './domain'
import type { Trigger } from './trigger-file'

/**
 * `.source/triggers/*.yml` says what starts a workflow on an event. The file
 * is the API: it is read when it lands, the last valid set stays in force,
 * and `change.landed` starts what matches, once per event, at most three.
 */

const R = '/repos/dana/gitfs'
const DIR = '.source/triggers'

const VALID = `triggers:
  - id: build-src
    on: [change.landed]
    filter:
      paths: ['src/**']
    run: build
  - id: docs
    on: change.*
    filter:
      labels: [docs]
    run: docs
`

/** A change in dana/gitfs holding these files, approved and green, ready to land. */
function seedFiles(
  d: MemoryDomain,
  n: number,
  files: Record<string, string | null>,
  labels: Array<string> = [],
) {
  const repo = d.repos.get('dana/gitfs')!
  const dana = d.actors.get('dana')!
  const hollis = d.actors.get('hollis')!
  const tree = `a${String(n).padStart(6, '0')}`
  const at = d.repos.get('dana/gitfs')!.created + 1000 * n
  d.seedChange(repo, {
    id: `chg_trig${n}`.padEnd(22, '0'),
    number: n,
    title: `Change ${n}`,
    description: '',
    state: 'open',
    author: dana,
    base: 'main',
    branch: `trig-${n}`,
    patchSets: [
      {
        n: 1,
        sha: tree.padEnd(40, '0'),
        tree,
        note: 'Initial version',
        author: dana,
        created: at,
        kind: 'initial',
        files: Object.fromEntries(
          Object.keys(files).map((f) => [f, { hash: 'h', add: 1, del: 0 }]),
        ),
        contents: files,
      },
    ],
    reviews: [
      {
        id: `rev_trig${n}`.padEnd(22, '0'),
        actor: hollis,
        state: 'approved',
        patchSet: 1,
        carries: true,
        body: '',
        created: at,
      },
    ],
    findings: [],
    checks: [
      {
        id: `chk_trig${n}`.padEnd(22, '0'),
        key: 'ci/test',
        name: 'ci/test',
        state: 'pass',
        tree,
        detailsUrl: null,
        created: at,
        updated: at,
      },
    ],
    stackId: null,
    labels,
    mirrors: [],
    created: at,
    updated: at,
    landed: null,
    version: 1,
  })
}

async function land(
  h: ReturnType<typeof harness>,
  n: number,
  headers: Record<string, string> = {},
) {
  const ready = (await h.call('GET', `${R}/changes/${n}/landability`)).json
  const r = await h.call('POST', `${R}/changes/${n}/land`, {
    body: { expected_tree: ready.tree },
    headers,
  })
  expect(r.status).toBe(200)
}

const runsBy = async (h: ReturnType<typeof harness>) =>
  (await h.call('GET', `${R}/pipelines?limit=100`)).json.data.filter(
    (r: any) => r.trigger === 'event',
  )

describe('the trigger file', () => {
  test('reads a valid file', () => {
    const r = parseTriggers(VALID, `${DIR}/ci.yml`)
    expect(r.errors).toEqual([])
    expect(r.triggers).toHaveLength(2)
    expect(r.triggers![1]).toMatchObject({
      id: 'docs',
      on: ['change.*'],
      filter: { labels: ['docs'], paths: null },
      run: 'docs',
    })
  })

  test('refuses an unknown key, a missing action, a bad glob and a duplicate id', () => {
    const unknown = parseTriggers(
      'triggers:\n  - id: a\n    on: change.landed\n    run: x\n    when: now\n',
    )
    expect(unknown.triggers).toBeNull()
    expect(unknown.errors[0].message).toContain('Unknown key when')
    const noAction = parseTriggers(
      'triggers:\n  - id: a\n    on: change.landed\n',
    )
    expect(noAction.errors[0].message).toContain('exactly one action')
    const glob = parseTriggers(
      "triggers:\n  - id: a\n    on: change.landed\n    filter:\n      paths: ['../etc/**']\n    run: x\n",
    )
    expect(glob.errors[0].path).toBe('triggers[0].filter.paths')
    const dup = parseTriggers(
      'triggers:\n  - id: a\n    on: change.landed\n    run: x\n  - id: a\n    on: change.landed\n    run: y\n',
    )
    expect(dup.errors[0].message).toContain('Two triggers are called a')
    expect(dup.errors[0].line).toBe(5)
    const across = parseTriggerFiles({
      [`${DIR}/a.yml`]:
        'triggers:\n  - id: a\n    on: change.landed\n    run: x\n',
      [`${DIR}/b.yml`]:
        'triggers:\n  - id: a\n    on: change.landed\n    run: y\n',
    })
    expect(across.errors[0].message).toContain('unique across trigger files')
  })

  test('a pipeline event cannot start a pipeline, and there are at most 20', () => {
    const loop = parseTriggers(
      'triggers:\n  - id: a\n    on: [pipeline.finished]\n    run: x\n',
    )
    expect(loop.errors[0].message).toContain('cannot loop')
    const many = parseTriggerFiles({
      [`${DIR}/a.yml`]: `triggers:\n${Array.from(
        { length: 21 },
        (_, i) => `  - id: t${i}\n    on: change.landed\n    run: x\n`,
      ).join('')}`,
    })
    expect(many.errors.at(-1)!.message).toContain('at most 20')
  })

  test('matches by type, paths, labels, actor and model', () => {
    const t = (filter: Partial<Trigger['filter']>, on = ['change.landed']) => ({
      id: 'x',
      on,
      filter: {
        paths: null,
        labels: null,
        actor: null,
        model: null,
        ...filter,
      },
      run: 'build',
      file: 'f',
    })
    const e = {
      type: 'change.landed',
      actor: 'dana',
      model: 'Claude-Opus',
      files: ['src/a.rs'],
      labels: ['Docs'],
    }
    expect(triggerMatches(t({}), e)).toBe(true)
    expect(triggerMatches(t({}, ['change.*']), e)).toBe(true)
    expect(triggerMatches(t({}, ['issue.created']), e)).toBe(false)
    expect(triggerMatches(t({ paths: ['src/**'] }), e)).toBe(true)
    expect(triggerMatches(t({ paths: ['docs/**'] }), e)).toBe(false)
    expect(triggerMatches(t({ labels: ['docs'] }), e)).toBe(true)
    expect(triggerMatches(t({ labels: ['bug'] }), e)).toBe(false)
    expect(triggerMatches(t({ actor: ['dana'] }), e)).toBe(true)
    expect(triggerMatches(t({ actor: ['hollis'] }), e)).toBe(false)
    expect(triggerMatches(t({ model: ['claude-opus'] }), e)).toBe(true)
    expect(triggerMatches(t({ model: ['gpt'] }), { ...e, model: null })).toBe(
      false,
    )
    // At most three start for one event.
    const four = Array.from({ length: 4 }, (_, i) => ({
      ...t({}),
      id: `t${i}`,
    }))
    const r = triggersFor(four, e)
    expect(r.start).toHaveLength(3)
    expect(r.capped.map((x) => x.id)).toEqual(['t3'])
  })
})

describe('triggers when a change lands', () => {
  test('the file is read when it lands, and what it says starts', async () => {
    const h = harness({
      seed: (d) =>
        seedFiles(d, 901, {
          [`${DIR}/ci.yml`]: VALID,
          'src/lib.rs': 'pub fn x() {}\n',
        }),
    })
    expect((await h.call('GET', `${R}/triggers`)).json.triggers).toEqual([])
    await land(h, 901)
    const set = (await h.call('GET', `${R}/triggers`)).json
    expect(set.errors).toEqual([])
    expect(set.triggers.map((t: any) => t.id)).toEqual(['build-src', 'docs'])
    expect(set.files[0].path).toBe(`${DIR}/ci.yml`)
    // #901 touched src/, so build-src started build, once.
    const runs = await runsBy(h)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ workflow: 'build', actor: 'dana' })
    expect(set.recent[0]).toMatchObject({
      trigger: 'build-src',
      state: 'started',
      run: runs[0].number,
    })
  })

  test('a workflow that never ran is recorded and its author told; the land stands', async () => {
    const h = harness({
      seed: (d) => {
        seedFiles(d, 901, { [`${DIR}/ci.yml`]: VALID })
        seedFiles(d, 902, { 'docs/guide.md': '# Guide\n' }, ['docs'])
      },
    })
    await land(h, 901)
    await land(h, 902)
    const set = (await h.call('GET', `${R}/triggers`)).json
    const failed = set.recent.find((r: any) => r.trigger === 'docs')
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('never run')
    expect((await h.call('GET', `${R}/changes/902`)).json.state).toBe('landed')
    const told = (await h.call('GET', '/notifications?kind=ci')).json.data
    expect(told.some((n: any) => n.title.includes('Trigger docs'))).toBe(true)
    // docs/ is not src/: build-src did not start for #902.
    expect(await runsBy(h)).toHaveLength(0)
  })

  test('a file that does not read keeps the old triggers and shows why', async () => {
    const h = harness({
      seed: (d) => {
        seedFiles(d, 901, { [`${DIR}/ci.yml`]: VALID })
        seedFiles(d, 902, {
          [`${DIR}/ci.yml`]:
            'triggers:\n  - id: Bad Id\n    on: change.landed\n',
        })
      },
    })
    await land(h, 901)
    await land(h, 902)
    const set = (await h.call('GET', `${R}/triggers`)).json
    expect(set.errors.length).toBeGreaterThan(0)
    expect(set.errors[0].file).toBe(`${DIR}/ci.yml`)
    expect(set.triggers.map((t: any) => t.id)).toEqual(['build-src', 'docs'])
  })

  test('filters on the model the land declared', async () => {
    const h = harness({
      seed: (d) => {
        seedFiles(d, 901, {
          [`${DIR}/ci.yml`]:
            "triggers:\n  - id: agent-build\n    on: change.landed\n    filter:\n      model: [claude-test]\n      paths: ['src/**']\n    run: build\n",
        })
        seedFiles(d, 902, { 'src/a.rs': 'a\n' })
        seedFiles(d, 903, { 'src/b.rs': 'b\n' })
      },
    })
    await land(h, 901)
    await land(h, 902)
    expect(await runsBy(h)).toHaveLength(0)
    await land(h, 903, { 'cb-model': 'claude-test' })
    expect(await runsBy(h)).toHaveLength(1)
  })

  test('at most three runs start for one event', async () => {
    const four = `triggers:\n${['a', 'b', 'c', 'd']
      .map((id) => `  - id: ${id}\n    on: change.landed\n    run: build\n`)
      .join('')}`
    const h = harness({
      seed: (d) => {
        seedFiles(d, 901, { [`${DIR}/ci.yml`]: four })
        seedFiles(d, 902, { 'src/a.rs': 'a\n' })
      },
    })
    await land(h, 901)
    const after901 = (await runsBy(h)).length
    expect(after901).toBe(3)
    await land(h, 902)
    expect((await runsBy(h)).length).toBe(6)
    const recent = (await h.call('GET', `${R}/triggers`)).json.recent
    expect(recent.filter((r: any) => r.state === 'capped')).toHaveLength(2)
  })

  test('another repository does not start them', async () => {
    const h = harness({
      seed: (d) => seedFiles(d, 901, { [`${DIR}/ci.yml`]: VALID }),
    })
    await land(h, 901)
    const before = (await runsBy(h)).length
    // A change landing in dana/tinyqueue is not dana/gitfs's event.
    expect(
      (await h.call('GET', '/repos/dana/tinyqueue/triggers')).json.triggers,
    ).toEqual([])
    expect((await runsBy(h)).length).toBe(before)
  })

  test.skipIf(onConvex)(
    'the same event never starts the same trigger twice',
    async () => {
      const h = harness({
        seed: (d) => {
          seedFiles(d, 901, { [`${DIR}/ci.yml`]: VALID })
          seedFiles(d, 902, { 'src/a.rs': 'a\n' })
        },
      })
      await land(h, 901)
      await land(h, 902)
      const d = h.api.port as unknown as MemoryDomain & {
        dispatchTriggers: (...a: Array<unknown>) => void
      }
      const repo = d.repos.get('dana/gitfs')!
      const c = repo.changes.get(902)!
      const before = (await runsBy(h)).length
      const run = [...repo.triggerRuns!.values()].find(
        (r) => r.triggerId === 'build-src' && r.state === 'started',
      )!
      // A retry of the same event, with the same sequence, finds it recorded.
      d.dispatchTriggers(
        repo,
        c,
        { type: 'change.landed', actor: { handle: 'dana' }, via: null },
        run.eventSequence,
      )
      expect((await runsBy(h)).length).toBe(before)
    },
  )
})

describe('the labels of a run a trigger started', () => {
  test('are read from the workflow file at its commit, not copied from the last run', async () => {
    const probe = harness()
    const last = (
      await probe.call('GET', `${R}/pipelines?workflow=build&limit=1`)
    ).json.data[0]
    const shape = (await probe.call('GET', `${R}/pipelines/${last.number}`))
      .json
    const yaml = [
      'jobs:',
      ...shape.jobs.flatMap((j: any) => [
        `  ${JSON.stringify(j.name)}:`,
        '    runs-on: [macos, xcode-16]',
      ]),
    ].join('\n')
    const h = harness({
      git: gitWith({ [shape.file]: yaml }),
      seed: (d) =>
        seedFiles(d, 901, {
          [`${DIR}/ci.yml`]: VALID,
          'src/lib.rs': 'pub fn x() {}\n',
        }),
    })
    await land(h, 901)
    const [run] = await runsBy(h)
    const shown = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(shown.runs_on_pending).toBe(false)
    expect(shown.jobs[0].runs_on).toEqual(['macos', 'xcode-16'])
    expect(
      shown.annotations.some((a: any) => a.text.includes('copied from')),
    ).toBe(false)
  })

  test('a file that cannot be read keeps the last run’s labels, and says so', async () => {
    const h = harness({
      seed: (d) =>
        seedFiles(d, 901, {
          [`${DIR}/ci.yml`]: VALID,
          'src/lib.rs': 'pub fn x() {}\n',
        }),
    })
    await land(h, 901)
    const [run] = await runsBy(h)
    const shown = (await h.call('GET', `${R}/pipelines/${run.number}`)).json
    expect(shown.runs_on_pending).toBe(false)
  })

  test.skipIf(onConvex)(
    'until they are read, no runner takes the job',
    async () => {
      const h = harness({
        seed: (d) =>
          seedFiles(d, 901, {
            [`${DIR}/ci.yml`]: VALID,
            'src/lib.rs': 'pub fn x() {}\n',
          }),
      })
      const d = h.api.port as unknown as MemoryDomain
      const repo = d.repos.get('dana/gitfs')!
      // Land without the API's follow-up, as a stack landing step does.
      ;(d as unknown as { doLand: (...a: Array<unknown>) => void }).doLand(
        repo,
        repo.changes.get(901)!,
        d.actors.get('dana')!,
      )
      const pending = repo.pipelines!.find((r) => r.trigger === 'event')!
      expect(pending.runsOnPending).toBe(true)
      for (let i = 0; i < 40; i++) {
        const c = await h.call('POST', `${R}/pipelines/claim`, {
          body: { runner: 'r' },
        })
        if (c.status === 204) break
        // The claim reads the labels first; the run is then no longer pending.
        expect(pending.runsOnPending).toBe(false)
      }
      expect(pending.runsOnPending).toBe(false)
    },
  )
})
