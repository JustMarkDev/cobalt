import { expect, test } from 'bun:test'
import { planPush, runOf, takesPush } from './actions'

const ci = `name: CI
on:
  push:
    branches: [main, 'release/**']
    paths-ignore: ['docs/**']
  pull_request:
jobs:
  test:
    name: Test
    runs-on: [self-hosted, macOS]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Tests
        run: bun test
  lint:
    needs: test
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [20, 22] }
    steps:
      - run: bun run lint
  shared:
    uses: org/repo/.github/workflows/shared.yml@main
`

test('a push to a matching branch starts the workflow, with what cobalt skips said', () => {
  const [p, ...more] = planPush(
    { '.github/workflows/ci.yml': ci, 'README.md': 'not a workflow' },
    { ref: 'refs/heads/release/1.2', sha: 'abc', actor: 'dana' },
  )
  expect(more).toEqual([])
  expect(p.workflow).toBe('CI')
  expect(p.branch).toBe('release/1.2')
  expect(
    p.jobs.map((j) => [j.name, j.runsOn, j.steps.map((s) => s.name)]),
  ).toEqual([
    [
      'Test',
      ['self-hosted', 'macos'],
      [
        'Run actions/checkout@v4',
        'Run oven-sh/setup-bun@v2',
        'bun install',
        'Tests',
      ],
    ],
    ['lint', ['ubuntu-latest'], ['bun run lint']],
  ])
  const notes = p.annotations.map((a) => a.text).join('\n')
  expect(notes).toContain('path filters')
  expect(notes).toContain('oven-sh/setup-bun@v2 is a GitHub Action')
  expect(notes).not.toContain('actions/checkout')
  expect(notes).toContain('has a matrix')
  expect(notes).toContain('needs other jobs')
  expect(notes).toContain('reusable workflow')
  const run = runOf(p, { number: 7, actor: 'dana', at: 0 })
  expect([run.number, run.status, run.trigger, run.file]).toEqual([
    7,
    'queued',
    'push',
    '.github/workflows/ci.yml',
  ])
})

test('on: as a word, a list, branches-ignore and tags', () => {
  expect(takesPush('push', 'refs/heads/x').yes).toBe(true)
  expect(takesPush(['pull_request'], 'refs/heads/x').yes).toBe(false)
  expect(
    takesPush({ push: { 'branches-ignore': ['wip/*'] } }, 'refs/heads/wip/a')
      .yes,
  ).toBe(false)
  expect(takesPush({ push: { tags: ['v*'] } }, 'refs/tags/v1.0.0').yes).toBe(
    true,
  )
  expect(takesPush({ push: { tags: ['v*'] } }, 'refs/heads/main').yes).toBe(
    false,
  )
  expect(takesPush({ push: { branches: ['main'] } }, 'refs/tags/v1').yes).toBe(
    false,
  )
  expect(
    planPush(
      { '.github/workflows/ci.yml': ci },
      { ref: 'refs/heads/feature', sha: 'a', actor: 'd' },
    ),
  ).toEqual([])
})
