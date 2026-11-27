import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { newId, randomSource } from './ids'

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

export const runnerOnlyScopes: ReadonlyArray<Scope> = [
  'runners:claim',
  'runners:report',
]

export const runnerScopes: ReadonlyArray<Scope> = [
  'repo:read',
  'runners:claim',
  'runners:report',
]

/**
 * What a runner's token may do, by its labels: every runner reads code and
 * takes jobs; one labelled `reviewer` also reads changes and writes
 * findings (the AI review), one labelled `t3` reads issues and changes to
 * hand them off.
 */
export function scopesForRunner(
  labels: ReadonlyArray<string> | null | undefined,
): Array<Scope> {
  const out = new Set<Scope>(runnerScopes)
  const has = (l: string) => (labels ?? []).includes(l)
  if (has('reviewer'))
    for (const s of ['pulls:read', 'pulls:comment'] as const) out.add(s)
  if (has('t3'))
    for (const s of ['issues:read', 'pulls:read'] as const) out.add(s)
  return [...out]
}

export const oauthScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) =>
    s !== 'tokens:manage' &&
    s !== 'secrets:decrypt' &&
    !runnerOnlyScopes.includes(s),
)

export const deviceScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) => s !== 'tokens:manage' && !runnerOnlyScopes.includes(s),
)

export const personScopes: ReadonlyArray<Scope> = allScopes.filter(
  (s) => !runnerOnlyScopes.includes(s),
)

export type Audience = 'api' | 'mcp'
export type TokenKind = 'personal' | 'oauth' | 'runner'

export type TokenRecord = {
  id: string
  name: string
  kind: TokenKind
  handle: string
  actingAs: string
  scopes: ReadonlyArray<Scope>
  repos: ReadonlyArray<string> | null
  paths?: ReadonlyArray<string> | null
  runnerId?: string | null
  device?: string | null
  audience: ReadonlyArray<Audience>
  prefix: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  authorizationId?: string
  limitKey?: string
  loginId?: string
}

export type Principal = {
  tokenId: string
  loginId: string
  limitKey: string
  budgetKey: string
  handle: string
  actingAs: string
  device: string
  session: boolean
  scopes: ReadonlySet<Scope>
  repos: ReadonlyArray<string> | null
  paths: ReadonlyArray<string> | null
  runnerId: string | null
  expiresAt: number
  capabilityKey: string
  capId: string
}

export type FindResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'audience' }

export interface TokenStore {
  findToken?: (
    token: string,
    audience: Audience,
    now: number,
  ) => FindResult | Promise<FindResult>
  find: (
    tokenHash: string,
    audience: Audience,
    now: number,
  ) => FindResult | Promise<FindResult>
  touch?: (record: TokenRecord, now: number) => void
  sweep?: (now: number) => void
}

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

export function internCapability(key: string): string {
  return base64url(sha256(utf8ToBytes(key))).slice(0, 16)
}

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const principals = new WeakMap<TokenRecord, Principal>()

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
  if (limits.paths) key += `:paths=${limits.paths.join(',')}`
  if (limits.runnerId) key += `:runner=${limits.runnerId}`
  return key
}

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
  loginId?: string
}

type MaybePromise<T> = T | Promise<T>

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
  renameRepo: (from: string, to: string) => MaybePromise<void>
  dropRepo: (full: string) => MaybePromise<void>
}

export class AuthStore implements TokenService {
  private readonly byHash = new Map<string, TokenRecord>()
  private readonly byId = new Map<string, TokenRecord>()
  private readonly byHandle = new Map<string, Set<TokenRecord>>()
  readonly authorizations = new Map<string, Authorization>()
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

  *entries(): Iterable<{ hash: string; record: TokenRecord }> {
    for (const [hash, record] of this.byHash) yield { hash, record }
  }

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

  private readonly revoked: Array<TokenRecord> = []
  private revokedFrom = 0
  static readonly REVOKED_KEPT = 50_000

  private readonly hashOf = new WeakMap<TokenRecord, string>()
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

  renameRepo(from: string, to: string) {
    const oldName = from.toLowerCase()
    const newName = to.toLowerCase()
    for (const t of this.byId.values()) {
      if (!t.repos) continue
      if (t.repos.includes(oldName))
        t.repos = t.repos.map((r) => (r === oldName ? newName : r))
      else if (t.repos.includes(newName))
        t.repos = t.repos.filter((r) => r !== newName)
    }
  }

  dropRepo(full: string) {
    const name = full.toLowerCase()
    for (const t of this.byId.values())
      if (t.repos?.includes(name)) t.repos = t.repos.filter((r) => r !== name)
  }

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

export { AuthStore as MemoryTokenStore }
