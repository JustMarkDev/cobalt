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
