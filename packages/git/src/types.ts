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

export type BlameLine = {
  line: number
  sha: string
  authorName: string
  authorEmail: string
  date: Date
  summary: string
  originalPath: string
  originalLine: number
}

export type Blame = {
  ref: string
  sha: string
  path: string
  lines: Array<BlameLine>
}

export type Comparison = {
  sha: string
  baseSha?: string
  mergeBaseSha?: string
  files: Array<FileDiff>
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
  getCommitDiff: (opts: { sha: string }) => Promise<{
    sha: string
    baseSha?: string
    files: Array<FileDiff>
  }>
  /** Who last touched each line of a file (`git blame`), computed by the store. */
  blame: (opts: { path: string; ref?: string }) => Promise<Blame>
  /**
   * What `head` changed since it split from `base` (`git diff base...head`).
   * `mergeBaseSha` is the commit where the two histories split.
   */
  compare: (opts: {
    base: string
    head: string
    paths?: Array<string>
  }) => Promise<Comparison>
}

export class GitError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitError'
    this.status = status
  }
}
