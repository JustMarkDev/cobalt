import { expect, test } from 'bun:test'
import {
  condition,
  evaluate,
  interpolate,
  newContext,
  readKeyValues,
} from './workflow-runner'
import { findingsOf } from './agent'

const ctx = () => {
  const c = newContext({
    sha: 'abc1234',
    branch: 'main',
    repository: 'dana/app',
    workspace: '/w',
    temp: '/t',
    matrix: { os: 'macos', node: 20 },
  })
  c.env = { GREETING: 'ciao' }
  c.steps = {
    make: {
      outputs: { artifact: 'x.tgz' },
      outcome: 'success',
      conclusion: 'success',
    },
  }
  return c
}

test('expressions as GitHub Actions reads them', () => {
  const c = ctx()
  expect(interpolate('${{ matrix.os }}-${{ matrix.node }}', c)).toBe('macos-20')
  expect(
    interpolate('${{ steps.make.outputs.artifact }} ${{ env.GREETING }}', c),
  ).toBe('x.tgz ciao')
  expect(
    evaluate("github.ref == 'refs/heads/main' && matrix.node >= 20", c),
  ).toBe(true)
  expect(evaluate("contains('hello world', 'WORLD')", c)).toBe(true)
  expect(evaluate("format('{0}/{1}', github.repository, github.sha)", c)).toBe(
    'dana/app/abc1234',
  )
  expect(evaluate("matrix.missing || 'fallback'", c)).toBe('fallback')
})

test('if: implies success(), unless it asks for another status', () => {
  const c = ctx()
  expect(condition(undefined, c)).toBe(true)
  expect(condition("matrix.os == 'macos'", c)).toBe(true)
  c.job = { status: 'failure' }
  expect(condition("matrix.os == 'macos'", c)).toBe(false)
  expect(condition('${{ failure() }}', c)).toBe(true)
  expect(condition('always()', c)).toBe(true)
})

test('GITHUB_OUTPUT and GITHUB_ENV, plain and heredoc', () => {
  expect(
    readKeyValues('a=1\nb=two=2\nnotes<<EOF\nline 1\nline 2\nEOF\n'),
  ).toEqual({
    a: '1',
    b: 'two=2',
    notes: 'line 1\nline 2',
  })
})

test('a reviewer answer becomes findings, bad ones left out', () => {
  expect(
    findingsOf(`Summary.
<findings>[
 {"severity":"high","file":"src/a.ts","line":7,"title":"SQL injection"},
 {"severity":"urgent","file":"src/a.ts","line":1,"title":"not a severity"},
 {"severity":"low","file":"src/b.ts","line":0,"title":"no line 0"}
]</findings>`),
  ).toEqual([
    { severity: 'high', file: 'src/a.ts', line: 7, title: 'SQL injection' },
  ])
  expect(findingsOf('no tags at all')).toEqual([])
})

test('a job of a reusable workflow, with what its caller passes', async () => {
  const { findJob } = await import('./workflow-runner')
  const caller = `jobs:
  release:
    name: Release
    uses: ./.github/workflows/release.yml
    with:
      channel: beta
`
  const called = `on:
  workflow_call:
    inputs:
      channel: { type: string, default: stable }
      dry: { type: boolean, default: true }
jobs:
  publish:
    name: Publish
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ inputs.channel }}
`
  const found = await findJob(caller, 'Release / Publish', (uses) =>
    Promise.resolve(uses === './.github/workflows/release.yml' ? called : null),
  )
  expect(found?.inputs).toEqual({ channel: 'beta', dry: true })
  expect((found!.job.steps as Array<{ run: string }>)[0].run).toContain(
    'inputs.channel',
  )
  expect(
    await findJob(caller, 'Release / Missing', () => Promise.resolve(called)),
  ).toBeNull()
})

test('a container step runs as GitHub runs it', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } =
    await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runStep } = await import('./workflow-runner')
  const root = mkdtempSync(join(tmpdir(), 'cb-docker-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // A stand-in docker that records what it is asked to run.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "$@" >> ${join(root, 'calls')}\n`,
  )
  chmodSync(join(bin, 'docker'), 0o755)
  const was = process.env.PATH
  process.env.PATH = `${bin}:${was}`
  try {
    const ws = join(root, 'ws')
    const temp = join(root, 'temp')
    mkdirSync(ws)
    mkdirSync(temp)
    const action = join(ws, 'act')
    mkdirSync(action)
    writeFileSync(
      join(action, 'action.yml'),
      `inputs:\n  who: { default: world }\nruns:\n  using: docker\n  image: docker://alpine:3.20\n  args: ['hello', '\${{ inputs.who }}']\n`,
    )
    const c = newContext({
      sha: 'abc',
      branch: 'main',
      repository: 'dana/app',
      workspace: ws,
      temp,
      matrix: {},
    })
    const rt = {
      workspace: ws,
      temp,
      cache: root,
      env: {},
      path: [],
      log: () => {},
    }
    expect(
      await runStep(
        { uses: 'docker://busybox:1', with: { args: 'echo hi' } },
        c,
        rt,
        's1',
      ),
    ).toBe('success')
    expect(
      await runStep({ uses: './act', with: { who: 'cobalt' } }, c, rt, 's2'),
    ).toBe('success')
    const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
    expect(calls[0]).toContain(`-v ${ws}:/github/workspace`)
    expect(calls[0]).toContain(`-v ${temp}:${temp}`)
    expect(calls[0].endsWith('busybox:1 echo hi')).toBe(true)
    expect(calls[1]).toContain('-e INPUT_WHO')
    expect(calls[1].endsWith('alpine:3.20 hello cobalt')).toBe(true)
  } finally {
    process.env.PATH = was
  }
})

test('a finding an earlier review raised is not raised again', async () => {
  const { sameFinding } = await import('./agent')
  const old = {
    file: 'src/users.ts',
    line: 7,
    title: 'SQL injection in findUser via string interpolation',
  }
  expect(
    sameFinding(old, { file: 'src/users.ts', line: 8, title: 'Unsafe query' }),
  ).toBe(true)
  expect(
    sameFinding(old, {
      file: 'src/users.ts',
      line: 30,
      title: 'SQL injection in findUser through interpolation',
    }),
  ).toBe(true)
  expect(
    sameFinding(old, {
      file: 'src/users.ts',
      line: 30,
      title: 'averageAge returns NaN',
    }),
  ).toBe(false)
  expect(
    sameFinding(old, { file: 'src/other.ts', line: 7, title: old.title }),
  ).toBe(false)
})
