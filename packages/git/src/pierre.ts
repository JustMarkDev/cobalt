import { NotFoundError, Pierre } from '@pierre/sdk'
import { GitError } from './types'
import type { Commit, FileDiff as WireDiff } from '@pierre/sdk'
import type { CommitInfo, FileDiff, GitRepo } from './types'

const commitOf = (c: Commit): CommitInfo => ({
  sha: c.sha,
  parentShas: c.parent_shas,
  message: c.message,
  authorName: c.author_name,
  authorEmail: c.author_email,
  committerName: c.committer_name,
  committerEmail: c.committer_email,
  date: new Date(c.date),
})

const stateOf = (code: string): FileDiff['state'] =>
  code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'

const diffOf = (f: WireDiff): FileDiff => ({
  path: f.path,
  state: stateOf(f.state),
  additions: f.additions,
  deletions: f.deletions,
  raw: f.raw,
})

export class GitNotConfigured extends Error {
  constructor() {
    super(
      'Code Storage is not configured: set PIERRE_ORG and PIERRE_PRIVATE_KEY.',
    )
    this.name = 'GitNotConfigured'
  }
}

let shared: Pierre | undefined

export function pierreFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pierre {
  if (shared) return shared
  if (!env.PIERRE_ORG || !env.PIERRE_PRIVATE_KEY) throw new GitNotConfigured()
  shared = new Pierre({
    org: env.PIERRE_ORG,
    privateKey: env.PIERRE_PRIVATE_KEY,
  })
  return shared
}

const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call()
  } catch (e) {
    const status = (e as { status?: number }).status
    if (typeof status === 'number' && e instanceof Error)
      throw new GitError(e.message, status)
    throw e
  }
}

export function pierreRepo(pierre: Pierre, storeId: string): GitRepo {
  return {
    listFiles: (opts) =>
      wrap(async () => {
        const page = await pierre.repos.files.list({
          repo_name: storeId,
          recursive: opts?.recursive ?? true,
          ...(opts?.ref ? { ref: opts.ref } : {}),
          ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        })
        const b = page.body
        return {
          ref: b.ref,
          paths: b.paths,
          hasMore: b.has_more,
          ...(b.next_cursor ? { nextCursor: b.next_cursor } : {}),
        }
      }),
    getFileStream: async (opts) => {
      try {
        return await pierre.repos.files.get({
          repo_name: storeId,
          path: opts.path,
          ...(opts.ref ? { ref: opts.ref } : {}),
        })
      } catch (e) {
        if (e instanceof NotFoundError && e.code === 'not_found')
          return new Response('not found', { status: 404 })
        return wrap(() => Promise.reject(e))
      }
    },
    listCommits: (opts) =>
      wrap(async () => {
        const page = await pierre.repos.commits.list({
          repo_name: storeId,
          ...(opts?.limit ? { limit: opts.limit } : {}),
          ...(opts?.branch ? { ref: opts.branch } : {}),
          ...(opts?.cursor ? { cursor: opts.cursor } : {}),
          ...(opts?.path ? { path: opts.path } : {}),
        })
        const b = page.body
        return {
          commits: b.commits.map(commitOf),
          hasMore: b.has_more,
          ...(b.next_cursor ? { nextCursor: b.next_cursor } : {}),
        }
      }),
    getCommit: (opts) =>
      wrap(async () => ({
        commit: commitOf(
          (
            await pierre.repos.commits.get({
              repo_name: storeId,
              ref: opts.sha,
            })
          ).commit,
        ),
      })),
    getCommitDiff: (opts) =>
      wrap(async () => {
        const d = await pierre.repos.diff.get({
          repo_name: storeId,
          ref: opts.sha,
        })
        const base =
          d.base_sha ??
          (await pierre.repos.commits.get({ repo_name: storeId, ref: d.sha }))
            .commit.parent_shas[0]
        return {
          sha: d.sha,
          ...(base ? { baseSha: base } : {}),
          files: d.files.map(diffOf),
        }
      }),
  }
}
