export type CommitInfo = {
  sha: string
  parentShas: Array<string>
  message: string
  authorName: string
  authorEmail: string
  committerName: string
  committerEmail: string
  date: Date
}

export type FileDiff = {
  path: string
  state: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  raw: string
}

export type ListFilesOptions = {
  ref?: string
  recursive?: boolean
  cursor?: string
}

export type ListCommitsOptions = {
  branch?: string
  cursor?: string
  limit?: number
  path?: string
}

export type MergeOptions = {
  /** The branch to merge from, at exactly this commit. */
  source: string
  sha: string
  target: string
  strategy: 'squash' | 'merge' | 'rebase'
  author: { name: string; email: string }
  message: string
}

export type CommitFilesOptions = {
  /** Made from `base` when it does not exist yet. */
  branch: string
  base: string
  files: Array<{ path: string; content: string | null }>
  message: string
  author: { name: string; email: string }
}

export interface GitRepo {
  listFiles: (opts?: ListFilesOptions) => Promise<{
    ref: string
    paths: Array<string>
    hasMore: boolean
    nextCursor?: string
  }>
  getFileStream: (opts: { path: string; ref?: string }) => Promise<Response>
  listCommits: (opts?: ListCommitsOptions) => Promise<{
    commits: Array<CommitInfo>
    hasMore: boolean
    nextCursor?: string
  }>
  getCommit: (opts: { sha: string }) => Promise<{ commit: CommitInfo }>
  /** Land `source` on `target` in the store; the commit `target` now points at. */
  merge?: (
    opts: MergeOptions,
  ) => Promise<{ sha: string; before: string | null }>
  /** A commit of these files on `branch`; its sha. */
  commitFiles?: (opts: CommitFilesOptions) => Promise<string>
  /** Against the first parent, or with `base` from where `sha` and `base` split (`git diff base...sha`). */
  getCommitDiff: (opts: { sha: string; base?: string }) => Promise<{
    sha: string
    baseSha?: string
    files: Array<FileDiff>
  }>
}

export class GitError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitError'
    this.status = status
  }
}
