import { expect, test } from 'bun:test'
import { environmentOf, isValuesFile, parseDotenv, withNames } from './dotenv'

test('which files hold values, and for which environment', () => {
  expect(
    ['.env', '.env.local', '.env.production', 'app/.env.preview'].every(
      isValuesFile,
    ),
  ).toBe(true)
  expect(
    ['.env.schema', '.env.example', 'env.ts', '.envrc'].some(isValuesFile),
  ).toBe(false)
  expect(environmentOf('.env')).toBe('development')
  expect(environmentOf('.env.local')).toBe('development')
  expect(environmentOf('.env.production.local')).toBe('production')
  expect(environmentOf('.env.staging')).toBe('preview')
})

test('values as dotenv writes them', () => {
  expect(
    parseDotenv(
      [
        '# a comment',
        'A=plain # trailing',
        'export B=exported',
        "C='single # kept'",
        'D="double\\nline"',
        'E="multi',
        'line"',
        'EMPTY=',
      ].join('\n'),
    ),
  ).toEqual([
    ['A', 'plain'],
    ['B', 'exported'],
    ['C', 'single # kept'],
    ['D', 'double\nline'],
    ['E', 'multi\nline'],
  ])
})

test('names go into the schema without their values', () => {
  const { schema, added } = withNames('# @defaultSensitive=true\n# ---\nA=\n', [
    'A',
    'B',
  ])
  expect(added).toEqual(['B'])
  expect(schema).toBe(
    '# @defaultSensitive=true\n# ---\nA=\n\n# @sensitive\nB=\n',
  )
  expect(withNames('', ['X']).schema).toContain('# ---\n# @sensitive\nX=\n')
})
