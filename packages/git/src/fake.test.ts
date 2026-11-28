import { expect, test } from 'bun:test'
import { parsePatchFiles } from '@pierre/diffs'
import { GitError } from './types'
import { getFakeGitRepo } from './fake'

test('fake repo walks history and produces patches Pierre can parse', async () => {
  const repo = getFakeGitRepo('tinyqueue')
  const { commits } = await repo.listCommits()
  expect(commits.length).toBe(61)
  expect(commits.slice(0, 3).map((c) => c.message)).toEqual([
    'Document retries',
    'Retry failed jobs with backoff',
    'Start the queue over',
  ])

  const diff = await repo.getCommitDiff({ sha: commits[1].sha })
  expect(diff.files.map((f) => [f.path, f.state])).toEqual([
    ['src/index.ts', 'modified'],
    ['src/retry.ts', 'added'],
  ])
  const parsed = parsePatchFiles(diff.files.map((f) => f.raw).join(''))
  expect(parsed[0].files.map((f) => f.name)).toEqual([
    'src/index.ts',
    'src/retry.ts',
  ])

  const old = await repo.listFiles({ ref: commits[2].sha.slice(0, 7) })
  expect(old.paths).not.toContain('src/retry.ts')
  expect((await repo.getFileStream({ path: 'missing' })).status).toBe(404)
})

test('unknown refs fail like the real SDK', async () => {
  const err = await getFakeGitRepo('tinyqueue')
    .getCommit({ sha: 'deadbeef' })
    .catch((e: unknown) => e)
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).status).toBe(404)
})

test('blame names the commit that last wrote each line', async () => {
  const repo = getFakeGitRepo('tinyqueue')
  const { commits } = await repo.listCommits()
  const [tip, retry, root] = commits.map((c) => c.sha)

  const index = await repo.blame({ path: 'src/index.ts' })
  expect(index.sha).toBe(tip)
  const by = new Map(index.lines.map((l) => [l.line, l.sha]))
  expect(index.lines.length).toBeGreaterThan(5)
  // `export type Job` was written in the first commit and never touched; the
  // retry import and the retry call were added in the second.
  expect(index.lines.find((l) => l.line === 1)?.sha).toBe(retry)
  expect(index.lines.find((l) => l.line === 3)?.sha).toBe(root)
  expect(by.get(index.lines.length)).toBe(root)
  expect(index.lines.find((l) => l.line === 3)?.summary).toBe(
    'Start the queue over',
  )

  const atRoot = await repo.blame({ path: 'src/index.ts', ref: root })
  expect(new Set(atRoot.lines.map((l) => l.sha))).toEqual(new Set([root]))

  const err = await repo.blame({ path: 'nope.ts' }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(GitError)
})

test('compare reports the merge base and what head changed since', async () => {
  const repo = getFakeGitRepo('tinyqueue')
  const { commits } = await repo.listCommits()
  const [tip, retry, root] = commits.map((c) => c.sha)

  const c = await repo.compare({ base: root, head: tip })
  expect(c.mergeBaseSha).toBe(root)
  expect(c.sha).toBe(tip)
  expect(c.files.map((f) => f.path).sort()).toEqual([
    'README.md',
    'src/index.ts',
    'src/retry.ts',
  ])

  const narrow = await repo.compare({ base: root, head: tip, paths: ['src'] })
  expect(narrow.files.map((f) => f.path)).toEqual([
    'src/index.ts',
    'src/retry.ts',
  ])

  // The other way round, head is the older commit: nothing changed on it.
  const back = await repo.compare({ base: tip, head: retry })
  expect(back.mergeBaseSha).toBe(retry)
  expect(back.files).toEqual([])
})

test('history can follow one path, and stop at a commit', async () => {
  const repo = getFakeGitRepo('tinyqueue')
  const { commits } = await repo.listCommits({ path: 'src/retry.ts' })
  expect(commits.map((c) => c.message)).toEqual([
    'Retry failed jobs with backoff',
  ])
  const all = (await repo.listCommits()).commits
  const older = await repo.listCommits({ branch: all[2].sha })
  expect(older.commits[0].sha).toBe(all[2].sha)
  expect(older.commits.length).toBe(all.length - 2)
})
