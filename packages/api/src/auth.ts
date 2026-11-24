import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { newId, randomSource } from './ids'

/**
 * Who a request is. A token maps to a principal: the account it belongs to,
 * the account it acts as, the scopes it holds, the repositories it may be
 * limited to, and the machine it was created on. There is one kind of actor:
 * an account. Whether a person or the agent they run typed a request is not
 * the server's business; every write records the machine, the tool and the
 * declared model instead (see `receipt.ts`).
 */

export const allScopes = [
  'repo:read',
  'repo:write',
  'issues:read',
  'issues:comment',
  'issues:write',
  'pulls:read',
  'pulls:comment',
  'pulls:write',
  'pulls:merge',
  'secrets:schema',
  'secrets:write',
  'secrets:decrypt',
  'webhooks:read',
  'webhooks:write',
  'tokens:manage',
  'runners:manage',
  'runners:claim',
  'runners:report',
] as const
export type Scope = (typeof allScopes)[number]

/**
 * What only a runner's own token holds: claiming jobs and reporting them. No
 * person, OAuth client or device login is given them.
 */
export const runnerOnlyScopes: ReadonlyArray<Scope> = [
  'runners:claim',
  'runners:report',
]

/** What a runner's token carries: read its repositories, claim and report. */
export const runnerScopes: ReadonlyArray<Scope> = [
  'repo:read',
  'runners:claim',
  'runners:report',
]

/** Scopes an OAuth client can be granted. A token never mints tokens. */
export const oauthScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) =>
    s !== 'tokens:manage' &&
    s !== 'secrets:decrypt' &&
    !runnerOnlyScopes.includes(s),
)

/**
 * What a device login may also ask for: secret values. A device login is a
 * person signing in their own machine (`cb auth login`), approved on a page
 * that names the machine and says so; a web application never gets values.
 */
export const deviceScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) => s !== 'tokens:manage' && !runnerOnlyScopes.includes(s),
)

/** What a person holds: every scope but the runner-only ones. */
export const personScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) => !runnerOnlyScopes.includes(s),
)

export type Audience = 'api' | 'mcp'
export type TokenKind = 'personal' | 'oauth' | 'runner'

export type TokenRecord = {
  id: string
  name: string
  kind: TokenKind
  /** The login. */
  handle: string
  /** The account the request acts as. Usually the same as `handle`. */
  actingAs: string
  scopes: ReadonlyArray<Scope>
  /** `owner/name` list when the token is limited to repositories. */
  repos: ReadonlyArray<string> | null
  /**
   * Globs (`src/**`, `*.sql`) when the token may only change these paths of
   * its one repository. Null or absent: any path.
   */
  paths?: ReadonlyArray<string> | null
  /** A runner's token: the runner it belongs to. */
  runnerId?: string | null
  /** The machine it was created on, as its owner named it. Receipts show it. */
  device?: string | null
  audience: ReadonlyArray<Audience>
  prefix: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  /** OAuth only: the authorization this token belongs to. */
  authorizationId?: string
  /** A stable key for shared limits, when this token is a short bridge identity. */
  limitKey?: string
  /** The login a short bridge token stands for, so confirmations follow it. */
  loginId?: string
}

export type Principal = {
  tokenId: string
  /**
   * The login this token belongs to: its OAuth authorization, which outlives
   * the hourly access tokens it mints, or the token itself. What a production
   * confirmation is bound to.
   */
  loginId: string
  limitKey: string
  /**
   * Whose budget a request draws from: one per login, so minting more tokens
   * or acting as an organization never buys more requests.
   */
  budgetKey: string
  handle: string
  actingAs: string
  /** The machine the token was created on; `browser` for a signed-in page. */
  device: string
  /** A signed-in page, not a token: the only place a person can confirm production access. */
  session: boolean
  scopes: ReadonlySet<Scope>
  repos: ReadonlyArray<string> | null
  /** Paths a change made with this token may touch; null for any. */
  paths: ReadonlyArray<string> | null
  /** Set when the caller is a runner, by its token. */
  runnerId: string | null
  expiresAt: number
  /** Everything that decides what this principal may do, as a cache key. */
  capabilityKey: string
  /** The same, as a short stand-in, for keys that are built on every request. */
  capId: string
}

export type FindResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'audience' }

export interface TokenStore {
  /**
   * Looks a token up as it arrived. A store may remember recent ones, so a busy
   * token is not hashed on every request. Revocation and expiry are still
   * checked on the record each time.
   */
  findToken?: (
    token: string,
    audience: Audience,
    now: number,
  ) => FindResult | Promise<FindResult>
  /** Looks a secret up by its hash. */
  find: (
    tokenHash: string,
    audience: Audience,
    now: number,
  ) => FindResult | Promise<FindResult>
  /** Note that the token was used. Never a write on every request. */
  touch?: (record: TokenRecord, now: number) => void
  /** Drop expired and long-revoked records. Called on a schedule when present. */
  sweep?: (now: number) => void
}

/** SHA-256 in hex. Plain JavaScript, so Convex functions hash the same way. */
export const hashToken = (token: string) =>
  bytesToHex(sha256(utf8ToBytes(token)))

export const tokenShape = /^cb[pofr]_[A-Za-z0-9_-]{8,}$/

const prefixes: Record<TokenKind, string> = {
  personal: 'cbp',
  oauth: 'cbo',
  runner: 'cbr',
}

export function secretFor(kind: TokenKind | 'refresh'): string {
  const p = kind === 'refresh' ? 'cbf' : prefixes[kind]
  return `${p}_${base64url(randomSource.bytes(24))}`
}

/** A short, stable name for a long capability key, with no unbounded map to grow. */
export function internCapability(key: string): string {
  return base64url(sha256(utf8ToBytes(key))).slice(0, 16)
}

/** Bytes as base64url, without padding, in any runtime. */
export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const principals = new WeakMap<TokenRecord, Principal>()

/** One principal per record, built once, so a request does no allocation for it. */
export function principalOf(record: TokenRecord): Principal {
  let p = principals.get(record)
  if (!p || p.repos !== record.repos || p.paths !== (record.paths ?? null)) {
    const scopes = new Set(record.scopes)
    p = {
      tokenId: record.id,
      loginId: record.loginId ?? record.authorizationId ?? record.id,
      limitKey: record.limitKey ?? record.id,
      budgetKey: `acct:${record.handle}`,
      handle: record.handle,
      actingAs: record.actingAs,
      device: record.device ?? record.name,
      session: false,
      scopes,
      repos: record.repos,
      paths: record.paths ?? null,
      runnerId: record.runnerId ?? null,
      expiresAt: record.expiresAt,
      // Everything that can change what this caller sees or may do.
      capabilityKey: capabilityKeyOf(record.handle, record.actingAs, scopes, {
        repos: record.repos,
        paths: record.paths ?? null,
        runnerId: record.runnerId ?? null,
      }),
      capId: '',
    }
    p.capId = internCapability(p.capabilityKey)
    principals.set(record, p)
  }
  return p
}

/** Everything that decides what a caller may do, as one string. */
export function capabilityKeyOf(
  handle: string,
  actingAs: string,
  scopes: Iterable<Scope>,
  limits: {
    repos: ReadonlyArray<string> | null
    paths: ReadonlyArray<string> | null
    runnerId: string | null
  },
) {
  let key = `${handle}:${actingAs}:${[...scopes].sort().join(',')}:${limits.repos?.join(',') ?? '*'}`
  // Added only when set, so every key from before stays what it was.
  if (limits.paths) key += `:paths=${limits.paths.join(',')}`
  if (limits.runnerId) key += `:runner=${limits.runnerId}`
  return key
}

/**
 * A person signed in to the app itself: they can do in the app whatever they
 * could do with a token holding every scope. No token exists for it.
 */
export function personPrincipal(handle: string, now: number): Principal {
  const scopes = new Set<Scope>(personScopes)
  const capabilityKey = capabilityKeyOf(handle, handle, scopes, {
    repos: null,
    paths: null,
    runnerId: null,
  })
  return {
    tokenId: `web:${handle}`,
    loginId: `web:${handle}`,
    limitKey: `web:${handle}`,
    budgetKey: `acct:${handle}`,
    handle,
    actingAs: handle,
    device: 'browser',
    session: true,
    scopes,
    repos: null,
    paths: null,
    runnerId: null,
    expiresAt: now + 60_000,
    capabilityKey,
    capId: internCapability(capabilityKey),
  }
}

export type Authorization = {
  id: string
  clientId: string
  clientName: string
  handle: string
  scopes: ReadonlyArray<Scope>
  audience: ReadonlyArray<Audience>
  /** The machine a device login named; receipts carry it. */
  device?: string | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export type CreateToken = {
  name: string
  kind: TokenKind
  handle: string
  actingAs?: string
  scopes: ReadonlyArray<Scope>
  repos?: ReadonlyArray<string> | null
  paths?: ReadonlyArray<string> | null
  runnerId?: string | null
  device?: string | null
  audience?: ReadonlyArray<Audience>
  ttlMs: number
  authorizationId?: string
  limitKey?: string
  /** For a bridge token: the login it stands for. */
  loginId?: string
}

type MaybePromise<T> = T | Promise<T>

/**
 * Tokens and OAuth authorizations, wherever they are kept: `AuthStore` in
 * memory, `ConvexTokens` (`stores/convex-tokens.ts`) in the database. Callers
 * await every answer, so either works.
 */
export interface TokenService extends TokenStore {
  create: (
    input: CreateToken & { id?: string },
  ) => MaybePromise<{ record: TokenRecord; secret: string }>
  get: (id: string) => MaybePromise<TokenRecord | null>
  list: (
    handle: string,
    kinds: ReadonlyArray<TokenKind>,
  ) => MaybePromise<Array<TokenRecord>>
  revoke: (id: string) => MaybePromise<boolean>
  countActive: (handle: string, now?: number) => MaybePromise<number>
  getAuthorization: (id: string) => MaybePromise<Authorization | null>
  createAuthorization: (
    input: Omit<Authorization, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
  ) => MaybePromise<Authorization>
  revokeAuthorization: (id: string) => MaybePromise<boolean>
  listAuthorizations: (handle: string) => MaybePromise<Array<Authorization>>
  /** A renamed repository keeps its name in every limited token. */
  renameRepo: (from: string, to: string) => MaybePromise<void>
  /** A deleted repository stops being reachable through any limited token. */
  dropRepo: (full: string) => MaybePromise<void>
}

/**
 * Tokens and OAuth authorizations, in memory. The hosted version keeps the same
 * surface in the database. Secrets are never stored, only their hashes.
 */
export class AuthStore implements TokenService {
  private readonly byHash = new Map<string, TokenRecord>()
  private readonly byId = new Map<string, TokenRecord>()
  /** Each person's tokens, so listing and counting them does not read everyone's. */
  private readonly byHandle = new Map<string, Set<TokenRecord>>()
  readonly authorizations = new Map<string, Authorization>()
  /** Tokens that stop working when their authorization is revoked. */
  private readonly byAuthorization = new Map<string, Set<TokenRecord>>()

  constructor(private readonly clock: () => number = Date.now) {}

  create(
    input: CreateToken & { id?: string },
    fixedSecret?: string,
  ): { record: TokenRecord; secret: string } {
    const secret = fixedSecret ?? secretFor(input.kind)
    const at = this.clock()
    const record: TokenRecord = {
      id: input.id ?? newId('token', at),
      name: input.name,
      kind: input.kind,
      handle: input.handle,
      actingAs: input.actingAs ?? input.handle,
      scopes: [...input.scopes],
      repos: input.repos ? input.repos.map((r) => r.toLowerCase()) : null,
      paths: input.paths ? [...input.paths] : null,
      runnerId: input.runnerId ?? null,
      device: input.device ?? null,
      audience: input.audience ?? ['api', 'mcp'],
      prefix: secret.slice(0, 8),
      createdAt: at,
      expiresAt: at + input.ttlMs,
      lastUsedAt: null,
      revokedAt: null,
      authorizationId: input.authorizationId,
      limitKey: input.limitKey,
      ...(input.loginId ? { loginId: input.loginId } : {}),
    }
    const hash = hashToken(secret)
    this.byHash.set(hash, record)
    this.hashOf.set(record, hash)
    this.byId.set(record.id, record)
    let own = this.byHandle.get(record.handle)
    if (!own) this.byHandle.set(record.handle, (own = new Set()))
    own.add(record)
    if (record.authorizationId) {
      const set = this.byAuthorization.get(record.authorizationId) ?? new Set()
      set.add(record)
      this.byAuthorization.set(record.authorizationId, set)
    }
    return { record, secret }
  }

  /** Every token with the hash of its secret, for copying the store elsewhere. */
  *entries(): Iterable<{ hash: string; record: TokenRecord }> {
    for (const [hash, record] of this.byHash) yield { hash, record }
  }

  /** Register a token whose secret already exists. Sample data uses it. */
  add(secret: string, input: CreateToken & { id?: string }) {
    return this.create(input, secret).record
  }

  private readonly recent = new Map<string, TokenRecord>()

  findToken(token: string, audience: Audience, now: number): FindResult {
    let record = this.recent.get(token)
    if (!record) {
      record = this.byHash.get(hashToken(token))
      if (!record) return { ok: false, reason: 'unknown' }
      if (this.recent.size >= 4096)
        this.recent.delete(this.recent.keys().next().value as string)
      this.recent.set(token, record)
      this.rawOf.set(record, token)
    }
    return this.check(record, audience, now)
  }

  find(tokenHash: string, audience: Audience, now: number): FindResult {
    const record = this.byHash.get(tokenHash)
    if (!record) return { ok: false, reason: 'unknown' }
    return this.check(record, audience, now)
  }

  private check(
    record: TokenRecord,
    audience: Audience,
    now: number,
  ): FindResult {
    if (record.revokedAt !== null) return { ok: false, reason: 'revoked' }
    if (record.expiresAt <= now) return { ok: false, reason: 'expired' }
    if (!record.audience.includes(audience))
      return { ok: false, reason: 'audience' }
    return { ok: true, record }
  }

  touch(record: TokenRecord, now: number) {
    // At most once a minute: reading a token must not become a write per request.
    if (record.lastUsedAt === null || now - record.lastUsedAt > 60_000)
      record.lastUsedAt = now
  }

  get(id: string) {
    return this.byId.get(id) ?? null
  }

  list(handle: string, kinds: ReadonlyArray<TokenKind>) {
    return [...(this.byHandle.get(handle) ?? [])]
      .filter(
        (t) =>
          t.handle === handle && kinds.includes(t.kind) && t.revokedAt === null,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Revoked tokens, oldest first. They are kept so the answer to one is `token_revoked`, but not without limit. */
  private readonly revoked: Array<TokenRecord> = []
  private revokedFrom = 0
  static readonly REVOKED_KEPT = 50_000

  private readonly hashOf = new WeakMap<TokenRecord, string>()
  /** The secret a record was last found by, so forgetting the record can forget that shortcut too. */
  private readonly rawOf = new WeakMap<TokenRecord, string>()

  private forgetByRecord(t: TokenRecord) {
    const hash = this.hashOf.get(t)
    if (hash) this.byHash.delete(hash)
    this.byId.delete(t.id)
    const own = this.byHandle.get(t.handle)
    own?.delete(t)
    if (own?.size === 0) this.byHandle.delete(t.handle)
    const raw = this.rawOf.get(t)
    if (raw !== undefined) this.recent.delete(raw)
  }

  revoke(id: string): boolean {
    const t = this.byId.get(id)
    if (!t || t.revokedAt !== null) return false
    t.revokedAt = this.clock()
    this.revoked.push(t)
    // Past the cap the oldest revocations are forgotten: such a token then answers
    // `token_invalid` instead of `token_revoked`, and it still does not work.
    while (this.revoked.length - this.revokedFrom > AuthStore.REVOKED_KEPT)
      this.forgetOldest()
    if (this.revokedFrom > 4096 && this.revokedFrom * 2 > this.revoked.length) {
      this.revoked.splice(0, this.revokedFrom)
      this.revokedFrom = 0
    }
    return true
  }

  private forgetOldest() {
    this.forgetByRecord(this.revoked[this.revokedFrom++])
  }

  // ----- OAuth authorizations ---------------------------------------------

  createAuthorization(
    input: Omit<Authorization, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
  ): Authorization {
    const a: Authorization = {
      ...input,
      id: newId('authorization', this.clock()),
      createdAt: this.clock(),
      lastUsedAt: null,
      revokedAt: null,
    }
    this.authorizations.set(a.id, a)
    return a
  }

  getAuthorization(id: string): Authorization | null {
    return this.authorizations.get(id) ?? null
  }

  revokeAuthorization(id: string): boolean {
    const a = this.authorizations.get(id)
    if (!a || a.revokedAt !== null) return false
    a.revokedAt = this.clock()
    for (const t of this.byAuthorization.get(id) ?? [])
      t.revokedAt ??= a.revokedAt
    return true
  }

  listAuthorizations(handle: string) {
    return [...this.authorizations.values()]
      .filter((a) => a.handle === handle && a.revokedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  countActive(handle: string, now = this.clock()) {
    let n = 0
    for (const t of this.byHandle.get(handle) ?? [])
      if (
        t.revokedAt === null &&
        t.kind !== 'oauth' &&
        t.kind !== 'runner' &&
        t.expiresAt > now
      )
        n++
    return n
  }

  /** A renamed repository keeps its name in every limited token. */
  renameRepo(from: string, to: string) {
    const oldName = from.toLowerCase()
    const newName = to.toLowerCase()
    for (const t of this.byId.values()) {
      if (!t.repos) continue
      if (t.repos.includes(oldName))
        t.repos = t.repos.map((r) => (r === oldName ? newName : r))
      // A different repository moving into a name this token holds is not the
      // repository the token was granted, so remove the name it collides with.
      else if (t.repos.includes(newName))
        t.repos = t.repos.filter((r) => r !== newName)
    }
  }

  /** A deleted repository stops being reachable through any limited token. */
  dropRepo(full: string) {
    const name = full.toLowerCase()
    for (const t of this.byId.values())
      if (t.repos?.includes(name)) t.repos = t.repos.filter((r) => r !== name)
  }

  /** Drop expired and long-revoked tokens, and authorizations revoked long ago. */
  sweep(now: number) {
    for (const t of Array.from(this.byId.values()))
      if (
        t.expiresAt + 86_400_000 < now ||
        (t.revokedAt && t.revokedAt + 86_400_000 < now)
      )
        this.forgetByRecord(t)
    for (const [id, a] of this.authorizations)
      if (a.revokedAt !== null && a.revokedAt + 86_400_000 < now) {
        this.authorizations.delete(id)
        this.byAuthorization.delete(id)
      }
  }
}

/** Kept for code and tests that build a store of fixed tokens. */
export { AuthStore as MemoryTokenStore }
