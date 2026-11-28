import { expect, test } from 'bun:test'
import { NotFoundError } from '@pierre/sdk'
import { GitError } from './types'
import { pierreRepo } from './pierre'
import type { Pierre } from '@pierre/sdk'

const commit = (sha: string) => ({
  sha,
  parent_shas: ['p'],
  message: 'm',
  author_name: 'a',
  author_email: 'a@x',
  committer_name: 'c',
  committer_email: 'c@x',
  date: '2026-11-24T10:00:00Z',
})

const client = (over: Record<string, unknown> = {}) =>
  ({
    repos: {
      files: {
        list: () =>
          Promise.resolve({
            body: {
              ref: 'abc',
              paths: ['a'],
              has_more: true,
              next_cursor: 'n',
            },
          }),
        get: () => Promise.resolve(new Response('hello')),
      },
      commits: {
        list: () =>
          Promise.resolve({
            body: { commits: [commit('s1')], has_more: false },
          }),
        get: () => Promise.resolve({ commit: commit('s1') }),
      },
      diff: {
        get: () =>
          Promise.resolve({
            sha: 's1',
            base_sha: 'p',
            files: [
              { path: 'a', state: 'A', additions: 1, deletions: 0, raw: 'r' },
              { path: 'b', state: 'R', additions: 0, deletions: 0, raw: 'r' },
              { path: 'c', state: 'D', additions: 0, deletions: 2, raw: 'r' },
            ],
          }),
      },
      blame: {
        get: () =>
          Promise.resolve({
            ref: 'main',
            commit_sha: 's1',
            path: 'a',
            lines: [
              {
                line_number: 1,
                commit_sha: 's0',
                author_name: 'a',
                author_email: 'a@x',
                author_time: '2026-11-24T10:00:00Z',
                summary: 'first',
                original_path: 'old',
                original_line_number: 4,
              },
            ],
          }),
      },
      ...over,
    },
  }) as unknown as Pierre

test('reads map the Code Storage shapes to the forge shapes', async () => {
  const repo = pierreRepo(client(), 'r')
  expect(await repo.listFiles()).toEqual({
    ref: 'abc',
    paths: ['a'],
    hasMore: true,
    nextCursor: 'n',
  })
  expect(await (await repo.getFileStream({ path: 'a' })).text()).toBe('hello')
  const { commits } = await repo.listCommits({ limit: 1 })
  expect(commits[0].parentShas).toEqual(['p'])
  expect(commits[0].date).toEqual(new Date('2026-11-24T10:00:00Z'))
  expect((await repo.getCommit({ sha: 's1' })).commit.authorName).toBe('a')
  const diff = await repo.getCommitDiff({ sha: 's1' })
  expect(diff.baseSha).toBe('p')
  expect(diff.files.map((f) => f.state)).toEqual([
    'added',
    'modified',
    'deleted',
  ])
})

test('a missing file answers 404, a missing repository throws', async () => {
  const missing = (code: string) =>
    client({
      files: {
        get: () => {
          return Promise.reject(
            Object.assign(Object.create(NotFoundError.prototype), {
              status: 404,
              code,
              message: code,
            }),
          )
        },
      },
    })
  const file = await pierreRepo(missing('not_found'), 'r').getFileStream({
    path: 'x',
  })
  expect(file.status).toBe(404)
  const err = await pierreRepo(missing('repository_not_found'), 'r')
    .getFileStream({ path: 'x' })
    .catch((e: unknown) => e)
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).status).toBe(404)
})

test('blame maps lines, compare asks for the merge base', async () => {
  const seen: Array<Record<string, unknown>> = []
  const repo = pierreRepo(
    client({
      diff: {
        get: (p: Record<string, unknown>) => {
          seen.push(p)
          return Promise.resolve({
            sha: 'h',
            base_sha: 'b',
            merge_base_sha: 'm',
            files: [
              { path: 'a', state: 'M', additions: 1, deletions: 1, raw: 'r' },
            ],
          })
        },
      },
    }),
    'r',
  )
  const blame = await repo.blame({ path: 'a', ref: 'main' })
  expect(blame.sha).toBe('s1')
  expect(blame.lines[0]).toEqual({
    line: 1,
    sha: 's0',
    authorName: 'a',
    authorEmail: 'a@x',
    date: new Date('2026-11-24T10:00:00Z'),
    summary: 'first',
    originalPath: 'old',
    originalLine: 4,
  })
  const c = await repo.compare({ base: 'b', head: 'h', paths: ['src'] })
  expect(c).toMatchObject({ sha: 'h', baseSha: 'b', mergeBaseSha: 'm' })
  expect(seen[0]).toMatchObject({ ref: 'h', base_ref: 'b', path: ['src'] })
})
