import { describe, expect, test } from 'bun:test'
import { globMatcher } from './glob'

function oldRegExp(glob: string) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

describe('globMatcher', () => {
  test.each([
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'lib/a.ts', false],
    ['**/migrations/**', 'db/migrations/001.sql', true],
    ['**/migrations/**', 'migrations/001.sql', true],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'a/b/c.ts', true],
    ['**/x', 'abx', false],
    ['*.ts', 'a/b.ts', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['docs/*.md', 'docs/a.md', true],
    ['a.b', 'axb', false],
  ])('%s against %s', (glob, path, want) => {
    expect(globMatcher(glob).test(path)).toBe(want)
  })

  test('answers as the regular expression did', () => {
    const parts = ['a', 'b', '/', '*', '**', '**/', '?', '.']
    const chars = ['a', 'b', '/', '.']
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 4000; i++) {
      let glob = ''
      for (let j = rand(6) + 1; j > 0; j--) glob += parts[rand(parts.length)]
      let path = ''
      for (let j = rand(9); j > 0; j--) path += chars[rand(chars.length)]
      expect([glob, path, globMatcher(glob).test(path)]).toEqual([
        glob,
        path,
        oldRegExp(glob).test(path),
      ])
    }
  })

  test('a glob built to backtrack answers at once', () => {
    const glob = `${Array(60).fill('**').join('/')}/z`
    const path = `${'a/'.repeat(2000)}b`
    const started = performance.now()
    expect(globMatcher(glob).test(path)).toBe(false)
    expect(globMatcher('*a'.repeat(100) + 'z').test('a'.repeat(4000))).toBe(
      false,
    )
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
