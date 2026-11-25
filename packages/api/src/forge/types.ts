// One interface for every git host a repository here can be linked to. A
// linked repository syncs with exactly one provider, through Code Storage;
// these adapters only talk to the provider's API: listing, reading, webhooks,
// sign-in, and the read-only import of pull requests, issues and releases.

import type { GitCredential } from '@cobaltforge/git/stores'

export type ProviderId = 'github' | 'gitlab' | 'codeberg'
export const PROVIDERS: ReadonlyArray<ProviderId> = [
  'github',
  'gitlab',
  'codeberg',
]

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** A repository as the provider describes it. */
export type RemoteRepo = {
  provider: ProviderId
  /** The provider's host, `github.com`. */
  instance: string
  /** The provider's own id for it, which survives renames. */
  id: string
  /** `owner/name` today. */
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
  /** What the person whose token listed it may do, when it is known. */
  canPush: boolean | null
  canAdmin: boolean | null
  /** GitHub only: the App installation that reaches it. */
  installation?: number
}

/**
 * Whose rights a call uses: a person's OAuth token, or (GitHub) the App's
 * installation, which reaches every repository it is installed on.
 */
export type ProviderAuth =
  | { kind: 'user'; token: string }
  | { kind: 'installation'; installation: number }

export type Page<T> = { items: Array<T>; next: string | null }

export type Capabilities = {
  /** `app`: Code Storage reaches the provider itself. `generic`: through a stored token. */
  mode: 'app' | 'generic'
  lfs: boolean
  /** `app`: one webhook for all repositories. `repo`: one per imported repository. */
  webhooks: 'app' | 'repo'
  /** How a delivery proves it came from the provider. */
  signature: 'hmac-sha256' | 'token'
  /** Whether a refresh token can be used only once. */
  refreshRotates: boolean
}

/** A person on the provider, kept as a snapshot rather than an account here. */
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
  created: number
  updated: number
  closed: number | null
  url: string
}

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
}

export type RemoteComment = {
  id: string
  /** The issue or pull request it is on. */
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

/** What a webhook delivery said, the same for every provider. */
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
      /** The repositories added or removed, by id, when the event names them. */
      added: Array<string>
      removed: Array<string>
    }
  | {
      kind: 'pull_request' | 'issues' | 'release' | 'comment' | 'checks'
      action: string
      repo: string
      slug: string
      number: number | null
      /** The actor named by the event, for deletions. */
      actor: ExternalActor | null
    }
  | { kind: 'ignored'; reason: string }

export type Delivery = {
  /** Unique per delivery; the receiver drops one it has seen. */
  id: string
  event: WebhookEvent
}

/** Conditional request state: send it back to get a 304 when nothing changed. */
export type Etag = string | null

export type Listed<T> = { items: Array<T>; etag: Etag; notModified: boolean }

export interface ForgeProvider {
  readonly id: ProviderId
  readonly host: string
  readonly capabilities: Capabilities

  /** The repositories the auth reaches, a page at a time. */
  listRepos: (
    auth: ProviderAuth,
    o: { cursor?: string | null; perPage?: number },
  ) => Promise<Page<RemoteRepo>>
  getRepo: (auth: ProviderAuth, slug: string) => Promise<RemoteRepo>
  /** Bytes per language, largest first. */
  languages: (
    auth: ProviderAuth,
    slug: string,
  ) => Promise<Array<[string, number]>>
  /** A file's text at the default branch, or null when there is none. */
  readFile: (
    auth: ProviderAuth,
    slug: string,
    path: string,
  ) => Promise<string | null>

  /** App mode: the installation that reaches a repository, if any. */
  installationOf?: (slug: string) => Promise<number | null>
  /** What Code Storage uses as the git password; null in app mode. */
  gitCredential: (auth: ProviderAuth, login: string) => GitCredential | null

  createWebhook: (
    auth: ProviderAuth,
    slug: string,
    hook: { url: string; secret: string },
  ) => Promise<{ id: string }>
  deleteWebhook: (auth: ProviderAuth, slug: string, id: string) => Promise<void>
  /** Checks a delivery against its secret. Never throws. */
  verifyWebhook: (
    headers: Headers,
    body: string,
    secret: string,
  ) => Promise<boolean>
  /** Reads a verified delivery. */
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
  /** The CI results on a commit: check runs and commit statuses. */
  checksOf?: (
    auth: ProviderAuth,
    slug: string,
    sha: string,
  ) => Promise<Array<RemoteCheck>>
  /**
   * The names of the repository's secrets, and of its environments' secrets.
   * Providers never give their values.
   */
  secretNames?: (
    auth: ProviderAuth,
    slug: string,
  ) => Promise<Array<{ name: string; environment: string | null }>>
  /** The files a pull request changes, with lines added and removed. */
  pullFiles?: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<Record<string, { add: number; del: number }>>
  /** The patch of a pull request, as `git apply` reads it. */
  pullPatch: (
    auth: ProviderAuth,
    slug: string,
    number: number,
  ) => Promise<string | null>
}

/** Signing in with a provider and keeping the token alive. */
export interface ProviderOAuth {
  readonly id: ProviderId
  /** The scopes asked for; GitLab needs `api` to make webhooks. */
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
  /** When the access token stops working, or null when it does not expire. */
  expiresAt: number | null
  scopes: Array<string>
}

/** A provider answered something other than success. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    message: string,
    /** The provider refused the credential itself: reconnect. */
    readonly auth = status === 401,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
