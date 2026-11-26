import type { GitCredential } from '@cobaltforge/git/stores'

export type ProviderId = 'github' | 'gitlab' | 'codeberg'
export const PROVIDERS: ReadonlyArray<ProviderId> = [
  'github',
  'gitlab',
  'codeberg',
]

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type RemoteRepo = {
  provider: ProviderId
  instance: string
  id: string
  slug: string
  private: boolean
  archived: boolean
  fork: boolean
  defaultBranch: string
  sizeBytes: number
  description: string
  stars: number
  forks: number
  license: string | null
  website: string | null
  canPush: boolean | null
  canAdmin: boolean | null
  installation?: number
}

export type ProviderAuth =
  | { kind: 'user'; token: string }
  | { kind: 'installation'; installation: number }

export type Page<T> = { items: Array<T>; next: string | null }

export type Capabilities = {
  mode: 'app' | 'generic'
  lfs: boolean
  webhooks: 'app' | 'repo'
  signature: 'hmac-sha256' | 'token'
  refreshRotates: boolean
}

export type ExternalActor = {
  id: string
  login: string
  name: string | null
  avatar: string | null
}

export type RemotePull = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: ExternalActor | null
  /** Label names, as the provider shows them. */
  labels?: Array<string>
  head: { ref: string; sha: string; fromFork: boolean }
  base: { ref: string }
  created: number
  updated: number
  closed: number | null
  merged: number | null
  url: string
}

export type RemoteIssue = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author: ExternalActor | null
  labels: Array<string>
  /** Why it was closed, where the provider says. */
  closedAs?: IssueClosedAs | null
  assignees?: Array<ExternalActor>
  created: number
  updated: number
  closed: number | null
  url: string
}

export type IssueClosedAs = 'completed' | 'not_planned' | 'duplicate'

export type RemoteRelease = {
  id: string
  tag: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  author: ExternalActor | null
  created: number
  published: number | null
  url: string
  /** The files attached to it, kept on the provider. */
  assets?: Array<RemoteAsset>
}

export type RemoteAsset = {
  name: string
  size: number
  /** How many times the provider served it. */
  downloads: number
  /** Where the provider serves it. */
  url: string
  /** Hex, when the provider computed one. */
  sha256: string | null
}

/** A label as the provider defines it. */
export type RemoteLabel = {
  name: string
  /** Hex without `#`, such as `d73a4a`. */
  color: string
  description: string
}

/** A review of a pull request: a verdict with an optional summary. */
export type RemoteReview = {
  id: string
  author: ExternalActor | null
  state: 'approved' | 'changes' | 'commented'
  body: string
  /** The commit it was given on. */
  sha: string | null
  created: number
}

/** A comment on a line of a pull request's diff. */
export type RemoteReviewComment = {
  id: string
  author: ExternalActor | null
  body: string
  path: string
  line: number | null
  /** The comment of the thread it answers. */
  replyTo: string | null
  created: number
  updated: number
}

export type RemoteComment = {
  id: string
  number: number
  body: string
  author: ExternalActor | null
  created: number
  updated: number
}

export type RemoteCheck = {
  id: string
  name: string
  state: 'pending' | 'pass' | 'fail'
  url: string | null
  created: number
  updated: number
}

export type WebhookEvent =
  | { kind: 'push'; repo: string; slug: string; ref: string }
  | {
      kind: 'repository'
      action:
        | 'renamed'
        | 'transferred'
        | 'archived'
        | 'unarchived'
        | 'deleted'
        | 'visibility'
        | 'edited'
      repo: string
      slug: string
      private: boolean
      archived: boolean
    }
  | {
      kind: 'installation'
      action:
        | 'created'
        | 'deleted'
        | 'suspend'
        | 'unsuspend'
        | 'added'
        | 'removed'
      installation: number
      added: Array<string>
      removed: Array<string>
    }
  | {
      kind: 'pull_request' | 'issues' | 'release' | 'comment' | 'checks'
      action: string
      repo: string
      slug: string
      number: number | null
      actor: ExternalActor | null
    }
  | { kind: 'ignored'; reason: string }

export type Delivery = {
  id: string
  event: WebhookEvent
}

export type Etag = string | null

export type Listed<T> = { items: Array<T>; etag: Etag; notModified: boolean }

export interface ForgeProvider {
  readonly id: ProviderId
  readonly host: string
  readonly capabilities: Capabilities

  listRepos: (
    auth: ProviderAuth,
    o: { cursor?: string | null; perPage?: number },
  ) => Promise<Page<RemoteRepo>>
  getRepo: (auth: ProviderAuth, slug: string) => Promise<RemoteRepo>
  languages: (
    auth: ProviderAuth,
    slug: string,
  ) => Promise<Array<[string, number]>>
  readFile: (
    auth: ProviderAuth,
    slug: string,
    path: string,
  ) => Promise<string | null>

  installationOf?: (slug: string) => Promise<number | null>
  gitCredential: (auth: ProviderAuth, login: string) => GitCredential | null

  createWebhook: (
    auth: ProviderAuth,
    slug: string,
    hook: { url: string; secret: string },
  ) => Promise<{ id: string }>
  deleteWebhook: (auth: ProviderAuth, slug: string, id: string) => Promise<void>
  verifyWebhook: (
    headers: Headers,
    body: string,
    secret: string,
  ) => Promise<boolean>
  parseWebhook: (headers: Headers, body: string) => Delivery

  listPulls: (
    auth: ProviderAuth,
    slug: string,
    o: { cursor?: string | null; etag?: Etag },
  ) => Promise<Listed<RemotePull> & { next: string | null }>
  listIssues: (
    auth: ProviderAuth,
    slug: string,
    o: { cursor?: string | null; etag?: Etag },
  ) => Promise<Listed<RemoteIssue> & { next: string | null }>
  listReleases: (
    auth: ProviderAuth,
    slug: string,
    o: { cursor?: string | null; etag?: Etag },
  ) => Promise<Listed<RemoteRelease> & { next: string | null }>
  listComments: (
    auth: ProviderAuth,
    slug: string,
    number: number,
    on?: 'issue' | 'pull',
  ) => Promise<Array<RemoteComment>>
  /** The repository's labels. */
  listLabels?: (auth: ProviderAuth, slug: string) => Promise<Array<RemoteLabel>>
  /** A pull request's reviews, oldest first. */
  listReviews?: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<Array<RemoteReview>>
  /** A pull request's comments on diff lines, oldest first. */
  listReviewComments?: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<Array<RemoteReviewComment>>
  checksOf?: (
    auth: ProviderAuth,
    slug: string,
    sha: string,
  ) => Promise<Array<RemoteCheck>>
  secretNames?: (
    auth: ProviderAuth,
    slug: string,
  ) => Promise<Array<{ name: string; environment: string | null }>>
  pullFiles?: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<Record<string, { add: number; del: number }>>
  pullPatch: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<string | null>
}

export interface ProviderOAuth {
  readonly id: ProviderId
  readonly scopes: ReadonlyArray<string>
  authorizeUrl: (state: string, redirectUri: string) => string
  exchange: (code: string, redirectUri: string) => Promise<OAuthTokens>
  refresh: (refreshToken: string) => Promise<OAuthTokens>
  revoke: (token: string) => Promise<void>
  whoami: (token: string) => Promise<{ id: string; login: string }>
}

export type OAuthTokens = {
  access: string
  refresh: string | null
  expiresAt: number | null
  scopes: Array<string>
}

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    message: string,
    readonly auth = status === 401,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
