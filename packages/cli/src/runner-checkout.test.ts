import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { checkout, inParallel } from './commands/runner'
import type { ApiClient } from './client'

test('inParallel runs everything, never more than the limit at once', async () => {
  let live = 0
  let peak = 0
  const done: Array<number> = []
  await inParallel([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5))
    done.push(n)
    live--
  })
  expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(peak).toBe(3)
  await inParallel([], 4, () => Promise.reject(new Error('never')))
})

test('inParallel stops on the first failure', async () => {
  const err = await inParallel([1, 2, 3], 1, (n) =>
    n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(),
  ).catch((e: unknown) => e)
  expect((err as Error).message).toBe('boom')
})

test('a checkout writes every file of the commit, text and binary, in parallel', async () => {
  const files: Record<string, { content: string; encoding: string }> = {
    'a.txt': { content: 'hello', encoding: 'utf-8' },
    'src/deep/b.bin': {
      content: Buffer.from([1, 2, 3]).toString('base64'),
      encoding: 'base64',
    },
    ...Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `many/${i}.txt`,
        { content: `file ${i}`, encoding: 'utf-8' },
      ]),
    ),
  }
  const asked: Array<string> = []
  let live = 0
  let peak = 0
  const api = {
    get: (_path: string, o: { query: Record<string, string> }) => {
      expect(o.query.ref).toBe('abc')
      return Promise.resolve({
        json: {
          entries: [
            { path: 'src', type: 'tree' },
            ...Object.keys(files).map((path) => ({ path, type: 'blob' })),
          ],
        },
      })
    },
    call: async (
      _m: string,
      _p: string,
      o: { query: Record<string, string> },
    ) => {
      asked.push(o.query.path)
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live--
      return { json: files[o.query.path] }
    },
  } as unknown as ApiClient
  const dir = mkdtempSync(join(tmpdir(), 'cb-checkout-'))
  try {
    await checkout(api, 'dana/gitfs', 'abc', dir)
    expect(asked.length).toBe(Object.keys(files).length)
    expect(asked).not.toContain('src')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello')
    expect([...readFileSync(join(dir, 'src/deep/b.bin'))]).toEqual([1, 2, 3])
    expect(readFileSync(join(dir, 'many/39.txt'), 'utf8')).toBe('file 39')
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(16)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
