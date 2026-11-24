import { run } from '../domain/convex'
import type { ConvexCall } from '../domain/convex'
import type {
  Audience,
  Authorization,
  CreateToken,
  FindResult,
  TokenKind,
  TokenRecord,
  TokenService,
} from '../auth'
import type { OAuthKind, OAuthState } from '../oauth-state'

type Expiring = { ok: false; reason: 'audience'; expiresAt: number }

export class ConvexTokens implements TokenService {
  constructor(private readonly call: ConvexCall) {}

  private q<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'query', `forge/tokens:${name}`, args, 'system')
  }

  private m<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'mutation', `forge/tokens:${name}`, args, 'system')
  }

  async find(hash: string, audience: Audience, now: number) {
    const found = await this.q<FindResult | Expiring>('find', {
      hash,
      audience,
    })
    const expiresAt = found.ok
      ? found.record.expiresAt
      : found.reason === 'audience'
        ? (found as Expiring).expiresAt
        : undefined
    if (expiresAt !== undefined && expiresAt <= now)
      return { ok: false, reason: 'expired' } as const
    if (!found.ok) return { ok: false, reason: found.reason } as const
    return found
  }

  touch(record: TokenRecord, now: number) {
    if (record.lastUsedAt === null || now - record.lastUsedAt > 60_000)
      void this.m('touch', { id: record.id }).catch(() => {})
  }

  create(input: CreateToken & { id?: string }) {
    const { repos, paths, ...rest } = input
    return this.m<{ record: TokenRecord; secret: string }>('create', {
      ...rest,
      scopes: [...input.scopes],
      repos: repos ? [...repos] : null,
      paths: paths ? [...paths] : null,
      ...(input.audience ? { audience: [...input.audience] } : {}),
    })
  }

  add(secret: string, input: CreateToken & { id?: string }) {
    return this.m<{ record: TokenRecord }>('create', {
      ...input,
      scopes: [...input.scopes],
      repos: input.repos ? [...input.repos] : null,
      paths: input.paths ? [...input.paths] : null,
      secret,
    })
  }

  get(id: string) {
    return this.q<TokenRecord | null>('get', { id })
  }

  list(handle: string, kinds: ReadonlyArray<TokenKind>) {
    return this.q<Array<TokenRecord>>('list', { handle, kinds: [...kinds] })
  }

  revoke(id: string) {
    return this.m<boolean>('revoke', { id })
  }

  countActive(handle: string, now = Date.now()) {
    return this.q<number>('countActive', { handle, at: now })
  }

  getAuthorization(id: string) {
    return this.q<Authorization | null>('getAuthorization', { id })
  }

  createAuthorization(
    input: Omit<Authorization, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>,
  ) {
    return this.m<Authorization>('createAuthorization', {
      ...input,
      scopes: [...input.scopes],
      audience: [...input.audience],
    })
  }

  revokeAuthorization(id: string) {
    return this.m<boolean>('revokeAuthorization', { id })
  }

  listAuthorizations(handle: string) {
    return this.q<Array<Authorization>>('listAuthorizations', { handle })
  }

  renameRepo() {}

  dropRepo() {}
}

export class ConvexOAuthState implements OAuthState {
  constructor(private readonly call: ConvexCall) {}

  private q<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'query', `forge/oauth:${name}`, args, 'system')
  }

  private m<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'mutation', `forge/oauth:${name}`, args, 'system')
  }

  async get<T>(kind: OAuthKind, key: string) {
    return (await this.q<T | null>('get', { kind, key })) ?? undefined
  }

  async set(
    kind: OAuthKind,
    key: string,
    value: unknown,
    expires: number | null,
  ) {
    await this.m('set', { kind, key, value: JSON.stringify(value), expires })
  }

  async delete(kind: OAuthKind, key: string) {
    await this.m('remove', { kind, key })
  }

  async use<T>(kind: OAuthKind, key: string) {
    return (await this.m<T | null>('use', { kind, key })) ?? undefined
  }

  swap(
    kind: OAuthKind,
    key: string,
    field: string,
    from: string,
    value: unknown,
    expires: number | null,
  ) {
    return this.m<boolean>('swap', {
      kind,
      key,
      field,
      from,
      value: JSON.stringify(value),
      expires,
    })
  }

  count(kind: OAuthKind, upTo: number) {
    return this.q<number>('count', { kind, upTo })
  }

  async sweep() {}
}
