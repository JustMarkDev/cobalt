import { apiError } from '../problem'
import { openState, signState } from '../github'
import { CredentialExists } from '@cobaltforge/git/stores'
import { webhookSecret } from './vault'
import type { TokenVault } from './vault'
import { PROVIDERS, ProviderError } from './types'
import { RemoteItems } from './items'
import { aboutOf } from './about'
import type { About } from './about'
import type { Materialize } from './items'
import { ACCESS_WARNING, LFS_WARNING, hostLabel } from './labels'

export { ACCESS_WARNING, LFS_WARNING, labelOf } from './labels'
import {
  presentAudit,
  presentConnection,
  presentJob,
  presentLink,
  presentProviderRepo,
  warningsOf,
} from './present'
import type { GitStores, Upstream } from '@cobaltforge/git/stores'
import type { Principal } from '../auth'
import type {
  ConnectionRec,
  JobItem,
  JobRec,
  ProviderStore,
  RemoteMeta,
  RemoteRec,
} from './store'
import type {
  ForgeProvider,
  ProviderAuth,
  ProviderId,
  ProviderOAuth,
  RemoteRepo,
  WebhookEvent,
} from './types'

export const PULL_TTL_MS = 60_000
export const STALE_MS = 6 * 60 * 60_000
const REFRESH_MARGIN_MS = 2 * 60_000
const REFRESH_LEASE_MS = 30_000
const ITEM_LEASE_MS = 10 * 60_000
const ITEM_ATTEMPTS = 6

export type SyncHost = {
  requireAdmin: (p: Principal, full: string) => Promise<void>
  unlink: (full: string) => Promise<void>
  mirror: (
    full: string,
    state: 'in-sync' | 'syncing' | 'behind' | 'failing',
    detail: string | null,
  ) => Promise<void>
  importOne: (
    p: Principal,
    prepared: Prepared,
    o: { owner: string; name: string; visibility: 'public' | 'private' },
  ) => Promise<{ full: string; created: boolean }>
  setLanguages?: (
    full: string,
    languages: Array<[string, number]>,
  ) => Promise<void>
  /**
   * Copies the provider's description, license and website onto the
   * repository here, where nobody here has set them otherwise. `was` is what
   * the provider said before, so a value copied earlier follows its edits.
   */
  setAbout?: (full: string, about: About, was: About | null) => Promise<void>
  hasCommit?: (full: string, sha: string) => Promise<boolean>
  materialize?: Materialize
}

export type SyncDeps = {
  store: ProviderStore & {
    claimSweeps?: (
      now: number,
      max: number,
    ) => Promise<Array<{ id: string; key: string }>>
    doneSweeps?: (ids: Array<string>) => Promise<void>
    sweepDeliveries?: (before: number) => Promise<void>
  }
  forges: Partial<Record<ProviderId, ForgeProvider>>
  oauth: Partial<Record<ProviderId, ProviderOAuth>>
  vault: TokenVault | null | Promise<TokenVault | null>
  git?: GitStores
  hookSecret: string | null
  githubHookSecret: string | null
  hookBase: string
  stateKey: string | null
  githubToken?: (access: string, handle: string) => Promise<string>
  githubAuthorize?: (
    access: string,
    handle: string,
    slug: string,
  ) => Promise<{ id: number; installation: number; defaultBranch: string }>
  now?: () => number
  log?: (line: Record<string, unknown>) => void
}

export type Prepared = {
  provider: ProviderId
  instance: string
  remote: RemoteRepo
  connection: ConnectionRec | null
  auth: ProviderAuth
}

const metaOf = (r: RemoteRepo): RemoteMeta => ({
  private: r.private,
  archived: r.archived,
  defaultBranch: r.defaultBranch,
  description: r.description,
  stars: r.stars,
  forks: r.forks,
  license: r.license,
  website: r.website,
})

export const upstreamOf = (provider: ProviderId, slug: string): Upstream => {
  const i = slug.indexOf('/')
  const j = slug.lastIndexOf('/')
  return {
    provider,
    owner: provider === 'gitlab' ? slug.slice(0, j) : slug.slice(0, i),
    name: slug.slice(j + 1),
  }
}

export function percents(
  bytes: Array<[string, number]>,
): Array<[string, number]> {
  const total = bytes.reduce((n, [, b]) => n + b, 0)
  if (!total) return []
  return bytes
    .map(([k, b]): [string, number] => [k, Math.round((b / total) * 1000) / 10])
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

export function delegated(handle: string, now: number): Principal {
  return {
    tokenId: 'tok_import_worker',
    loginId: `import:${handle}`,
    limitKey: `import:${handle}`,
    budgetKey: `import:${handle}`,
    handle,
    actingAs: handle,
    device: 'import-worker',
    session: false,
    scopes: new Set(['repo:read', 'repo:write']) as Principal['scopes'],
    repos: null,
    paths: null,
    runnerId: null,
    expiresAt: now + ITEM_LEASE_MS,
    capabilityKey: '',
    capId: '',
  }
}

export class ProviderSync {
  readonly now: () => number
  host: SyncHost | null = null
  private readonly refreshing = new Map<string, Promise<ConnectionRec>>()

  constructor(readonly deps: SyncDeps) {
    this.now = deps.now ?? Date.now
  }

  private remoteItems: RemoteItems | null = null

  attach(host: SyncHost) {
    this.host = host
    this.remoteItems = new RemoteItems(
      this,
      host.hasCommit ?? (() => Promise.resolve(false)),
      host.materialize,
    )
  }

  get items(): RemoteItems {
    if (!this.remoteItems)
      throw new Error('ProviderSync is not attached to a domain.')
    return this.remoteItems
  }

  async scheduleItems(full: string, delay: number) {
    const r = await this.store.remoteOfRepo(full)
    if (!r) throw apiError('not_found', `${full} is not linked to a provider.`)
    if (delay === 0) await this.store.patchRemote(r.id, { importedAt: null })
    await this.store.setItemsDue(full, this.now() + delay)
  }

  private need() {
    if (!this.host) throw new Error('ProviderSync is not attached to a domain.')
    return this.host
  }

  get store() {
    return this.deps.store
  }

  forge(id: ProviderId): ForgeProvider {
    const f = this.deps.forges[id]
    if (!f)
      throw apiError(
        'backend_unavailable',
        `Linking ${hostLabel[id]} is not set up on this server.`,
        { hint: `The operator must configure the ${hostLabel[id]} app.` },
      )
    return f
  }

  configured(id: ProviderId) {
    return Boolean(this.deps.forges[id])
  }

  private oauth(id: ProviderId): ProviderOAuth {
    const o = this.deps.oauth[id]
    if (!o)
      throw apiError(
        'backend_unavailable',
        `Signing in with ${hostLabel[id]} is not set up on this server.`,
        {
          hint: `The operator must set ${id.toUpperCase()}_CLIENT_ID and ${id.toUpperCase()}_CLIENT_SECRET.`,
        },
      )
    return o
  }

  private async vault() {
    const v = await this.deps.vault
    if (!v)
      throw apiError(
        'backend_unavailable',
        'Provider tokens cannot be stored on this server.',
        { hint: 'The operator must set CB_TOKEN_KEYS.' },
      )
    return v
  }

  private slot(c: { id: string }, field: 'token' | 'refresh') {
    return { kind: 'providerConnection', id: c.id, field }
  }

  async connectStart(
    p: Principal,
    provider: ProviderId,
    redirectUri: string,
    returnTo: string | null,
  ) {
    const o = this.oauth(provider)
    if (!this.deps.stateKey)
      throw apiError(
        'backend_unavailable',
        'OAuth is not set up on this server.',
      )
    const state = await signState(`${this.deps.stateKey}:${provider}`, {
      h: p.handle,
      r: redirectUri,
      t: returnTo,
      x: this.now() + 10 * 60_000,
    })
    return { url: o.authorizeUrl(state, redirectUri) }
  }

  async connectFinish(
    p: Principal,
    provider: ProviderId,
    body: { code: string; state: string; redirect_uri: string },
  ) {
    const o = this.oauth(provider)
    const s = await openState(
      `${this.deps.stateKey}:${provider}`,
      body.state,
      p.handle,
      body.redirect_uri,
      this.now(),
    )
    let tokens
    try {
      tokens = await o.exchange(body.code, body.redirect_uri)
    } catch {
      throw apiError(
        'forbidden',
        `${hostLabel[provider]} did not accept that sign-in. It may have been used already.`,
        { hint: `Connect ${hostLabel[provider]} again.` },
      )
    }
    const who = await o.whoami(tokens.access)
    const instance = this.forge(provider).host
    const had = await this.store.connection(p.handle, provider, instance)
    if (
      had &&
      had.externalId !== who.id &&
      (await this.store.remotesOfConnection(had.id)).length
    )
      throw apiError(
        'invalid_state',
        `You are connected to ${hostLabel[provider]} as ${had.login}, and repositories sync through that account.`,
        { hint: `Disconnect ${had.login} first, or sign in as ${had.login}.` },
      )
    const saved = await this.store.saveConnection(
      {
        handle: p.handle,
        provider,
        instance,
        externalId: who.id,
        login: who.login,
        token: null,
        refresh: null,
        keyId: null,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        state: 'ok',
        problem: null,
      },
      this.now(),
    )
    const v = await this.vault()
    await this.store.patchConnection(
      saved.id,
      {
        token: await v.seal(this.slot(saved, 'token'), tokens.access),
        refresh: tokens.refresh
          ? await v.seal(this.slot(saved, 'refresh'), tokens.refresh)
          : null,
        keyId: v.current,
      },
      this.now(),
    )
    await this.store.audit({
      handle: p.handle,
      provider,
      action: had ? 'reconnected' : 'connected',
      repo: null,
      detail: who.login,
      at: this.now(),
    })
    const fresh = (await this.store.connectionById(saved.id))!
    for (const r of await this.store.remotesOfConnection(saved.id))
      if (r.state === 'broken' || r.state === 'delayed')
        await this.healRemote(r, fresh).catch((e: unknown) =>
          this.deps.log?.({
            msg: 'heal failed',
            repo: r.repo,
            error: String(e),
          }),
        )
    return { connection: fresh, returnTo: s.t }
  }

  /**
   * After a GitHub sign-in: the account's GitHub connection, with the user's
   * own token sealed, so writes to GitHub (comments, issues) are theirs and
   * not the app's. Without a vault the login is kept and writes stay the app's.
   */
  async rememberGithub(
    handle: string,
    login: string,
    tokens?: {
      access: string
      refresh: string | null
      expiresAt: number | null
    },
  ) {
    const had = await this.store.connection(handle, 'github', 'github.com')
    const saved =
      had?.login === login
        ? had
        : await this.store.saveConnection(
            {
              handle,
              provider: 'github',
              instance: 'github.com',
              externalId: login.toLowerCase(),
              login,
              token: null,
              refresh: null,
              keyId: null,
              expiresAt: null,
              scopes: [],
              state: 'ok',
              problem: null,
            },
            this.now(),
          )
    const v = tokens ? await this.deps.vault : null
    if (tokens && v)
      await this.store.patchConnection(
        saved.id,
        {
          token: await v.seal(this.slot(saved, 'token'), tokens.access),
          refresh: tokens.refresh
            ? await v.seal(this.slot(saved, 'refresh'), tokens.refresh)
            : null,
          keyId: v.current,
          expiresAt: tokens.expiresAt,
          state: 'ok',
          problem: null,
        },
        this.now(),
      )
    if (had?.login !== login)
      await this.store.audit({
        handle,
        provider: 'github',
        action: had ? 'reconnected' : 'connected',
        repo: null,
        detail: login,
        at: this.now(),
      })
  }

  async githubLogin(handle: string) {
    return (
      (await this.store.connection(handle, 'github', 'github.com'))?.login ??
      null
    )
  }

  /** The user's own GitHub auth, when they signed in with a kept token. */
  async githubAs(handle: string): Promise<ProviderAuth | null> {
    const c = await this.store.connection(handle, 'github', 'github.com')
    if (!c?.token) return null
    return this.userAuth(c).catch(() => null)
  }

  async userAuth(c: ConnectionRec): Promise<ProviderAuth> {
    const fresh = await this.fresh(c)
    if (!fresh.token)
      throw apiError(
        'invalid_state',
        `The ${hostLabel[c.provider]} connection of ${c.handle} has no token.`,
        { hint: `Connect ${hostLabel[c.provider]} again.` },
      )
    return {
      kind: 'user',
      token: await (
        await this.vault()
      ).open(this.slot(fresh, 'token'), fresh.token),
    }
  }

  private needsReconnect(c: ConnectionRec) {
    return apiError(
      'invalid_state',
      `The ${hostLabel[c.provider]} connection of ${c.handle} (${c.login}) stopped working${c.problem ? `: ${c.problem}` : ''}.`,
      {
        hint: `${c.handle} must connect ${hostLabel[c.provider]} again, or an admin of the repository can take the link over with their own connection.`,
      },
    )
  }

  async fresh(c: ConnectionRec): Promise<ConnectionRec> {
    if (c.state === 'needs_reconnect') throw this.needsReconnect(c)
    if (c.expiresAt === null || c.expiresAt - this.now() > REFRESH_MARGIN_MS)
      return c
    const running = this.refreshing.get(c.id)
    if (running) return running
    const p = this.refresh(c).finally(() => this.refreshing.delete(c.id))
    this.refreshing.set(c.id, p)
    return p
  }

  private async refresh(c: ConnectionRec): Promise<ConnectionRec> {
    const leased = await this.store.leaseRefresh(
      c.id,
      this.now(),
      REFRESH_LEASE_MS,
    )
    if (!leased) {
      const t = this.now()
      while (this.now() - t < REFRESH_LEASE_MS) {
        await new Promise((r) => setTimeout(r, 500))
        const now = await this.store.connectionById(c.id)
        if (!now) throw this.needsReconnect(c)
        if (now.state === 'needs_reconnect') throw this.needsReconnect(now)
        if (now.expiresAt !== c.expiresAt) return now
      }
      throw apiError(
        'backend_unavailable',
        'Refreshing the provider token timed out.',
      )
    }
    const v = await this.vault()
    const fail = async (problem: string) => {
      await this.store.patchConnection(
        c.id,
        { state: 'needs_reconnect', problem, refreshLease: null },
        this.now(),
      )
      await this.store.audit({
        handle: c.handle,
        provider: c.provider,
        action: 'needs_reconnect',
        repo: null,
        detail: problem,
        at: this.now(),
      })
      throw this.needsReconnect({ ...c, problem })
    }
    if (!leased.refresh)
      return fail('the token expired and cannot be refreshed')
    let tokens
    try {
      tokens = await this.oauth(c.provider).refresh(
        await v.open(this.slot(leased, 'refresh'), leased.refresh),
      )
    } catch (e) {
      if (e instanceof ProviderError && !e.auth && e.status >= 500) {
        await this.store.patchConnection(
          c.id,
          { refreshLease: null },
          this.now(),
        )
        throw apiError(
          'backend_unavailable',
          `${hostLabel[c.provider]} did not answer the token refresh (${e.status}).`,
        )
      }
      return fail(
        `the provider refused the refresh token (${e instanceof Error ? e.message : String(e)})`,
      )
    }
    const patch = {
      token: await v.seal(this.slot(leased, 'token'), tokens.access),
      refresh: tokens.refresh
        ? await v.seal(this.slot(leased, 'refresh'), tokens.refresh)
        : leased.refresh,
      keyId: v.current,
      expiresAt: tokens.expiresAt,
      state: 'ok' as const,
      problem: null,
      refreshLease: null,
    }
    await this.store.patchConnection(c.id, patch, this.now())
    return { ...leased, ...patch }
  }

  async connections(handle: string) {
    return this.store.connections(handle)
  }

  async disconnect(p: Principal, provider: ProviderId) {
    const instance = this.deps.forges[provider]?.host ?? defaultHost[provider]
    const c = await this.store.connection(p.handle, provider, instance)
    if (!c)
      throw apiError(
        'not_found',
        `You are not connected to ${hostLabel[provider]}.`,
      )
    let auth: ProviderAuth | null = null
    try {
      auth = c.token ? await this.userAuth(c) : null
    } catch {
      auth = null
    }
    for (const r of await this.store.remotesOfConnection(c.id)) {
      await this.cut(r, auth)
      await this.store.audit({
        handle: p.handle,
        provider,
        action: 'unlinked',
        repo: r.repo,
        detail: 'disconnected',
        at: this.now(),
      })
    }
    if (auth?.kind === 'user')
      await this.deps.oauth[provider]?.revoke(auth.token).catch(() => undefined)
    await this.store.deleteConnection(c.id)
    await this.store.audit({
      handle: p.handle,
      provider,
      action: 'disconnected',
      repo: null,
      detail: c.login,
      at: this.now(),
    })
  }

  async unlinkRepo(p: Principal, full: string) {
    const r = await this.store.remoteOfRepo(full)
    if (!r) return false
    const auth = await this.authOf(r).catch(() => null)
    await this.cut(r, auth)
    await this.store.audit({
      handle: p.handle,
      provider: r.provider,
      action: 'unlinked',
      repo: full,
      detail: r.fullName,
      at: this.now(),
    })
    return true
  }

  with(over: Partial<SyncDeps>) {
    return new ProviderSync({ ...this.deps, ...over })
  }

  private async cut(r: RemoteRec, auth: ProviderAuth | null) {
    const forge = this.deps.forges[r.provider]
    if (forge && auth && r.webhookId)
      await forge
        .deleteWebhook(auth, r.fullName, r.webhookId)
        .catch(() => undefined)
    if (r.credentialId)
      await this.deps.git
        ?.deleteCredential(r.storeId, r.credentialId)
        .catch(() => undefined)
    await this.deps.git?.detach(r.storeId).catch((e: unknown) => {
      if (statusOf(e) !== 404) throw e
    })
    await this.store.dropRemote(r.id)
    await this.need().unlink(r.repo)
  }

  async prepare(
    p: Principal,
    provider: ProviderId,
    slug: string,
    githubAccess?: string,
  ): Promise<Prepared> {
    const forge = this.forge(provider)
    if (provider === 'github') {
      if (!githubAccess)
        throw apiError(
          'invalid_request',
          'Importing from GitHub needs `github_access`.',
          {
            hint: 'Sign in with GitHub first: POST /github/device, then poll /github/device/poll.',
          },
        )
      if (!this.deps.githubAuthorize)
        throw apiError(
          'backend_unavailable',
          'Signing in with GitHub is not set up on this server.',
        )
      const ref = await this.deps.githubAuthorize(githubAccess, p.handle, slug)
      const auth: ProviderAuth = {
        kind: 'installation',
        installation: ref.installation,
      }
      const remote = await forge.getRepo(auth, slug).catch(() => null)
      return {
        provider,
        instance: forge.host,
        auth,
        connection: null,
        remote: remote ?? {
          provider,
          instance: forge.host,
          id: String(ref.id),
          slug,
          private: true,
          archived: false,
          fork: false,
          defaultBranch: ref.defaultBranch,
          sizeBytes: 0,
          description: '',
          stars: 0,
          forks: 0,
          license: null,
          website: null,
          canPush: true,
          canAdmin: null,
          installation: ref.installation,
        },
      }
    }
    const c = await this.store.connection(p.handle, provider, forge.host)
    if (!c)
      throw apiError('invalid_state', `Connect ${hostLabel[provider]} first.`, {
        hint: `POST /providers/${provider}/oauth, then finish it with POST /providers/${provider}/oauth/finish.`,
      })
    const auth = await this.userAuth(c)
    let remote: RemoteRepo
    try {
      remote = await forge.getRepo(auth, slug)
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404)
        throw apiError(
          'not_found',
          `${hostLabel[provider]} has no repository ${slug} you can see.`,
        )
      throw this.providerProblem(e)
    }
    if (remote.canPush === false)
      throw apiError(
        'forbidden',
        `You cannot push to ${slug} on ${hostLabel[provider]}.`,
        { hint: 'Only someone who can push to it there can link it here.' },
      )
    return { provider, instance: forge.host, remote, connection: c, auth }
  }

  providerProblem(e: unknown) {
    if (e instanceof ProviderError)
      return e.auth
        ? apiError(
            'forbidden',
            `${hostLabel[e.provider]} no longer accepts this connection.`,
            {
              hint: `Connect ${hostLabel[e.provider]} again.`,
            },
          )
        : apiError('backend_unavailable', e.message)
    return e
  }

  link(pr: Prepared) {
    return {
      upstream: upstreamOf(pr.provider, pr.remote.slug),
      defaultBranch: pr.remote.defaultBranch,
    }
  }

  async heldBy(pr: Prepared) {
    return this.store.remoteByExternal(pr.provider, pr.instance, pr.remote.id)
  }

  async linked(p: Principal, full: string, pr: Prepared) {
    const forge = this.forge(pr.provider)
    const rec = await this.store.claimRemote({
      provider: pr.provider,
      instance: pr.instance,
      externalId: pr.remote.id,
      fullName: pr.remote.slug,
      repo: full,
      connectionId: pr.connection?.id ?? null,
      by: p.handle,
      state: 'syncing',
      problem: null,
      installation: pr.remote.installation ?? null,
      webhookId: null,
      credentialId: null,
      lfs: false,
      meta: metaOf(pr.remote),
      lastPull: this.now(),
      lastSync: null,
      at: this.now(),
    })
    const warnings = [ACCESS_WARNING(hostLabel[pr.provider], pr.remote.slug)]
    const lfs = await forge
      .readFile(pr.auth, pr.remote.slug, '.gitattributes')
      .then((t) => Boolean(t && /filter\s*=\s*lfs/.test(t)))
      .catch(() => false)
    if (lfs && !forge.capabilities.lfs)
      warnings.push(LFS_WARNING(hostLabel[pr.provider]))
    const patch: Parameters<ProviderStore['patchRemote']>[1] = { lfs }
    if (forge.capabilities.mode === 'generic' && pr.connection) {
      patch.credentialId = await this.writeCredential(rec, pr)
      patch.etags = { _cred: String(pr.connection.expiresAt ?? 'none') }
      patch.webhookId = await this.hook(rec, pr)
      if (!patch.webhookId) {
        patch.state = 'delayed'
        patch.problem = `Cobalt could not add a webhook on ${hostLabel[pr.provider]} (it needs a maintainer or owner there), so changes made there arrive late: when someone here fetches, or within a few hours.`
        warnings.push(patch.problem)
      }
    }
    await this.store.patchRemote(rec.id, patch)
    await this.store.setItemsDue(full, this.now())
    const host = this.need()
    if (host.setLanguages)
      await forge
        .languages(pr.auth, pr.remote.slug)
        .then((l) => host.setLanguages!(full, percents(l)))
        .catch(() => undefined)
    await host.setAbout?.(full, aboutOf(pr.remote), null)
    await this.store.audit({
      handle: p.handle,
      provider: pr.provider,
      action: 'imported',
      repo: full,
      detail: pr.remote.slug,
      at: this.now(),
    })
    return { remote: { ...rec, ...patch }, warnings }
  }

  private async writeCredential(rec: RemoteRec, pr: Prepared) {
    const git = this.deps.git
    if (!git || pr.auth.kind !== 'user' || !pr.connection) return null
    const cred = this.forge(pr.provider).gitCredential(
      pr.auth,
      pr.connection.login,
    )
    if (!cred) return null
    try {
      return await git.setCredential(rec.storeId, cred)
    } catch (e) {
      if (!(e instanceof CredentialExists) || !rec.credentialId) throw e
      await git.updateCredential(rec.storeId, rec.credentialId, cred)
      return rec.credentialId
    }
  }

  private async hook(rec: RemoteRec, pr: Prepared): Promise<string | null> {
    if (!this.deps.hookSecret || pr.auth.kind !== 'user') return null
    try {
      const h = await this.forge(pr.provider).createWebhook(
        pr.auth,
        rec.fullName,
        {
          url: `${this.deps.hookBase}/${pr.provider}`,
          secret: await webhookSecret(
            this.deps.hookSecret,
            `${pr.provider}:${rec.externalId}`,
          ),
        },
      )
      return h.id
    } catch (e) {
      this.deps.log?.({
        msg: 'webhook not created',
        repo: rec.repo,
        error: String(e),
      })
      return null
    }
  }

  private async healRemote(r: RemoteRec, c: ConnectionRec) {
    const forge = this.forge(r.provider)
    const auth = await this.userAuth(c)
    const pr: Prepared = {
      provider: r.provider,
      instance: r.instance,
      remote: await forge.getRepo(auth, r.fullName),
      connection: c,
      auth,
    }
    const patch: Parameters<ProviderStore['patchRemote']>[1] = {
      connectionId: c.id,
      by: c.handle,
      credentialId: await this.writeCredential(r, pr),
      etags: { ...r.etags, _cred: String(c.expiresAt ?? 'none') },
      meta: metaOf(pr.remote),
    }
    if (!r.webhookId) patch.webhookId = await this.hook(r, pr)
    const hooked = Boolean(r.webhookId || patch.webhookId)
    patch.state = hooked ? 'linked' : 'delayed'
    patch.problem = hooked ? null : r.problem
    await this.store.patchRemote(r.id, patch)
    await this.pull({ ...r, ...patch }).catch(() => undefined)
  }

  /**
   * Link a repository made here to GitHub, making the GitHub repository when
   * there is none, so it syncs both ways as an import does. The GitHub one
   * must be empty: its history comes from here.
   */
  async publish(
    p: Principal,
    full: string,
    o: {
      storeId: string
      slug: string
      githubAccess: string
      private: boolean
      description: string
      defaultBranch: string
      /**
       * Sends the history here to `target`. Linking makes the store follow
       * GitHub, so GitHub must have the history first or it is lost here.
       */
      sendHistory: (target: {
        url: string
        authorization: string
      }) => Promise<void>
    },
  ) {
    if (await this.store.remoteOfRepo(full))
      throw apiError('invalid_state', `${full} is already linked to a host.`)
    const forge = this.forge('github')
    if (!this.deps.githubToken || !this.deps.git)
      throw apiError(
        'backend_unavailable',
        'Signing in with GitHub is not set up on this server.',
      )
    const token = await this.deps.githubToken(o.githubAccess, p.handle)
    const auth: ProviderAuth = { kind: 'user', token }
    const found = await forge.getRepo(auth, o.slug).catch((e: unknown) => {
      if (e instanceof ProviderError && e.status === 404) return null
      throw this.providerProblem(e)
    })
    if (found && found.sizeBytes > 0)
      throw apiError(
        'invalid_state',
        `${o.slug} on GitHub already has history.`,
        {
          hint: 'Link an empty repository, or import that one instead with POST /imports.',
        },
      )
    if (!found) {
      if (!forge.createRepo)
        throw apiError(
          'invalid_request',
          'GitHub repositories cannot be made from here.',
        )
      const [owner, name] = o.slug.split('/')
      await forge
        .createRepo(auth, {
          owner,
          name,
          private: o.private,
          description: o.description,
        })
        .catch((e: unknown) => {
          if (e instanceof ProviderError && [403, 404, 422].includes(e.status))
            throw apiError(
              'forbidden',
              `GitHub did not let cobalt make ${o.slug}: ${e.message}`,
              {
                hint: 'Make an empty repository with that name on GitHub and link it again, or give the Cobalt GitHub App the Administration permission so it can make them.',
              },
            )
          throw this.providerProblem(e)
        })
    }
    const pr = await this.prepare(p, 'github', o.slug, o.githubAccess)
    const held = await this.heldBy(pr)
    if (held)
      throw apiError(
        'invalid_state',
        `${o.slug} is already linked to ${held.repo}.`,
      )
    await o
      .sendHistory({
        url: `https://github.com/${pr.remote.slug}.git`,
        authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
      })
      .catch((e: unknown) => {
        throw apiError(
          'backend_unavailable',
          `The history did not reach ${pr.remote.slug} on GitHub, so nothing was linked: ${String(e)}`,
        )
      })
    await this.deps.git
      .relink(o.storeId, upstreamOf('github', pr.remote.slug), o.defaultBranch)
      .catch((e: unknown) => {
        throw apiError(
          'backend_unavailable',
          `Git storage did not take the GitHub link: ${String(e)}`,
        )
      })
    const done = await this.linked(p, full, pr)
    await this.store.audit({
      handle: p.handle,
      provider: 'github',
      action: 'published',
      repo: full,
      detail: pr.remote.slug,
      at: this.now(),
    })
    return { ...done, slug: pr.remote.slug, made: !found }
  }

  async adopt(p: Principal, full: string) {
    await this.need().requireAdmin(p, full)
    const r = await this.store.remoteOfRepo(full)
    if (!r) throw apiError('not_found', `${full} is not linked to a provider.`)
    if (r.provider === 'github')
      throw apiError(
        'invalid_state',
        'A GitHub link is kept by the Cobalt GitHub App: there is nothing to adopt.',
        {
          hint: 'If it stopped syncing, install the app on the repository again.',
        },
      )
    const forge = this.forge(r.provider)
    const c = await this.store.connection(p.handle, r.provider, forge.host)
    if (!c)
      throw apiError('invalid_state', `Connect ${hostLabel[r.provider]} first.`)
    const auth = await this.userAuth(c)
    const remote = await forge.getRepo(auth, r.fullName).catch((e: unknown) => {
      throw this.providerProblem(e)
    })
    if (remote.canPush === false)
      throw apiError(
        'forbidden',
        `You cannot push to ${r.fullName} on ${hostLabel[r.provider]}.`,
      )
    if (remote.id !== r.externalId)
      throw apiError(
        'invalid_state',
        `${r.fullName} on ${hostLabel[r.provider]} is no longer the repository this one was linked to.`,
      )
    const old = r.connectionId
      ? await this.store.connectionById(r.connectionId)
      : null
    if (old && r.webhookId && old.id !== c.id) {
      const oldAuth = await this.userAuth(old).catch(() => null)
      if (oldAuth)
        await forge
          .deleteWebhook(oldAuth, r.fullName, r.webhookId)
          .catch(() => undefined)
      await this.store.patchRemote(r.id, { webhookId: null })
      r.webhookId = null
    }
    await this.healRemote(r, c)
    await this.store.audit({
      handle: p.handle,
      provider: r.provider,
      action: 'adopted',
      repo: full,
      detail: old ? `from ${old.handle}` : null,
      at: this.now(),
    })
    return (await this.store.remoteOfRepo(full))!
  }

  async beforeGit(full: string, write: boolean) {
    const r = await this.store.remoteOfRepo(full)
    if (!r || r.state === 'gone') return
    if (r.state === 'broken' && write)
      throw apiError(
        'invalid_state',
        `${full} is not syncing with ${hostLabel[r.provider]}: ${r.problem ?? 'the link is broken'}.`,
        {
          hint:
            r.provider === 'github'
              ? 'Install the Cobalt GitHub App on that repository again.'
              : `An admin of ${full} with a ${hostLabel[r.provider]} connection can take the link over (POST /repos/${full}/upstream/adopt).`,
        },
      )
    await this.credential(r)
    if (!write && this.now() - r.lastPull > PULL_TTL_MS)
      await this.pull(r).catch((e: unknown) =>
        this.deps.log?.({
          msg: 'lazy pull failed',
          repo: full,
          error: String(e),
        }),
      )
  }

  private async credential(r: RemoteRec) {
    if (!r.connectionId || !this.deps.git) return
    const c = await this.store.connectionById(r.connectionId)
    if (!c) return
    let fresh: ConnectionRec
    try {
      fresh = await this.fresh(c)
    } catch (e) {
      await this.store.patchRemote(r.id, {
        state: 'broken',
        problem: `The ${hostLabel[c.provider]} connection of ${c.handle} stopped working.`,
      })
      await this.need().mirror(
        r.repo,
        'failing',
        `The ${hostLabel[c.provider]} connection of ${c.handle} stopped working.`,
      )
      throw e
    }
    const stamp = String(fresh.expiresAt ?? 'none')
    if (r.etags._cred === stamp && r.credentialId) return
    const auth = await this.userAuth(fresh)
    const cred = this.forge(r.provider).gitCredential(auth, fresh.login)
    if (!cred) return
    let id = r.credentialId
    if (id) await this.deps.git.updateCredential(r.storeId, id, cred)
    else
      id = await this.deps.git
        .setCredential(r.storeId, cred)
        .catch((e: unknown) => {
          if (e instanceof CredentialExists)
            throw apiError(
              'invalid_state',
              `Code Storage holds a credential for ${r.repo} that Cobalt does not know.`,
              { hint: 'Unlink and import the repository again.' },
            )
          throw e
        })
    r.credentialId = id
    r.etags = { ...r.etags, _cred: stamp }
    await this.store.patchRemote(r.id, { credentialId: id, etags: r.etags })
  }

  async pull(r: RemoteRec) {
    if (!this.deps.git) return
    await this.credential(r)
    try {
      await this.deps.git.pull(r.storeId)
    } catch (e) {
      if (codeOf(e) !== 'sync_in_progress') throw e
    }
    await this.store.patchRemote(r.id, { lastPull: this.now() })
  }

  async receiveRequest(provider: string, req: Request): Promise<Response> {
    if (!(PROVIDERS as ReadonlyArray<string>).includes(provider))
      return new Response('No such provider.', { status: 404 })
    const body = await req.text()
    if (body.length > 5 * 1024 * 1024)
      return new Response('The delivery is too large.', { status: 413 })
    const r = await this.receive(provider as ProviderId, req.headers, body)
    return new Response(r.text, {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  async receive(
    provider: ProviderId,
    headers: Headers,
    body: string,
  ): Promise<{ status: number; text: string }> {
    const forge = this.deps.forges[provider]
    if (!forge) return { status: 404, text: `${provider} is not set up here.` }
    let delivery
    try {
      delivery = forge.parseWebhook(headers, body)
    } catch {
      return { status: 400, text: 'Unreadable delivery.' }
    }
    const ev = delivery.event
    let remote: RemoteRec | null = null
    let secret: string | null
    if (forge.capabilities.webhooks === 'app')
      secret = this.deps.githubHookSecret
    else {
      if (!('repo' in ev)) return { status: 202, text: 'ignored' }
      remote = await this.store.remoteByExternal(provider, forge.host, ev.repo)
      secret =
        remote && this.deps.hookSecret
          ? await webhookSecret(
              this.deps.hookSecret,
              `${provider}:${remote.externalId}`,
            )
          : null
    }
    if (!secret || !(await forge.verifyWebhook(headers, body, secret)))
      return { status: 401, text: 'The signature does not match.' }
    if (!delivery.id) return { status: 400, text: 'No delivery id.' }
    if (await this.store.seen(provider, delivery.id, this.now()))
      return { status: 200, text: 'duplicate' }
    try {
      return { status: 200, text: await this.act(provider, ev, remote) }
    } catch (e) {
      this.deps.log?.({
        msg: 'webhook failed',
        provider,
        kind: ev.kind,
        error: String(e),
      })
      return { status: 500, text: 'failed' }
    }
  }

  private async act(
    provider: ProviderId,
    ev: WebhookEvent,
    known: RemoteRec | null,
  ): Promise<string> {
    const forge = this.forge(provider)
    if (ev.kind === 'ignored') return `ignored: ${ev.reason}`
    if (ev.kind === 'installation') {
      const all = await this.store.remotesOfInstallation(ev.installation)
      const byId = (ids: Array<string>) =>
        all.filter((r) => ids.includes(r.externalId))
      const lost =
        ev.action === 'deleted' || ev.action === 'suspend'
          ? all
          : ev.action === 'removed'
            ? byId(ev.removed)
            : []
      for (const r of lost) {
        await this.store.patchRemote(r.id, {
          state: 'broken',
          problem: 'The Cobalt GitHub App no longer reaches this repository.',
        })
        await this.need().mirror(
          r.repo,
          'failing',
          'The Cobalt GitHub App was removed from this repository on GitHub.',
        )
      }
      const back =
        ev.action === 'unsuspend' || ev.action === 'created'
          ? all
          : ev.action === 'added'
            ? byId(ev.added)
            : []
      for (const r of back.filter((x) => x.state === 'broken')) {
        await this.store.patchRemote(r.id, { state: 'linked', problem: null })
        await this.pull(r).catch(() => undefined)
      }
      return `installation ${ev.action}: ${lost.length} broken, ${back.length} back`
    }
    const r =
      known ??
      (await this.store.remoteByExternal(provider, forge.host, ev.repo))
    if (!r) return 'not linked here'
    switch (ev.kind) {
      case 'push':
        await this.pull(r)
        if (r.state === 'syncing' || r.state === 'delayed')
          await this.store.patchRemote(r.id, {
            state: r.webhookId || provider === 'github' ? 'linked' : r.state,
          })
        return 'pulled'
      case 'repository':
        return this.repositoryChanged(r, ev)
      default:
        await this.items.onEvent(r, ev)
        return `${ev.kind} noted`
    }
  }

  private async repositoryChanged(
    r: RemoteRec,
    ev: Extract<WebhookEvent, { kind: 'repository' }>,
  ) {
    if (ev.action === 'deleted') {
      await this.deps.git?.detach(r.storeId).catch(() => undefined)
      await this.store.patchRemote(r.id, {
        state: 'gone',
        problem: `${r.fullName} was deleted on ${hostLabel[r.provider]}. The repository here keeps its history.`,
      })
      await this.need().mirror(
        r.repo,
        'failing',
        `${r.fullName} was deleted on ${hostLabel[r.provider]}.`,
      )
      return 'gone'
    }
    if (ev.action === 'renamed' || ev.action === 'transferred') {
      if (ev.slug !== r.fullName && this.deps.git)
        await this.deps.git.relink(
          r.storeId,
          upstreamOf(r.provider, ev.slug),
          r.meta.defaultBranch,
        )
      await this.store.patchRemote(r.id, {
        fullName: ev.slug,
        ...(r.state === 'broken' ? {} : { state: 'linked', problem: null }),
      })
      await this.store.audit({
        handle: r.by,
        provider: r.provider,
        action: 'relinked',
        repo: r.repo,
        detail: `${r.fullName} -> ${ev.slug}`,
        at: this.now(),
      })
      return 'relinked'
    }
    await this.refreshMeta({ ...r, fullName: ev.slug })
    if (ev.action === 'archived' || ev.action === 'unarchived')
      await this.store.patchRemote(r.id, {
        state: ev.archived ? 'archived' : 'linked',
        problem: ev.archived
          ? `${r.fullName} is archived on ${hostLabel[r.provider]}: pushes to it are refused there.`
          : null,
      })
    return ev.action
  }

  async refreshMeta(r: RemoteRec) {
    const forge = this.forge(r.provider)
    const auth = await this.authOf(r)
    if (!auth) return
    const remote = await forge.getRepo(auth, r.fullName)
    await this.store.patchRemote(r.id, {
      meta: metaOf(remote),
      fullName: remote.slug,
    })
    const host = this.need()
    await host
      .setAbout?.(r.repo, aboutOf(remote), aboutOf(r.meta))
      .catch(() => undefined)
    if (host.setLanguages)
      await forge
        .languages(auth, remote.slug)
        .then((l) => host.setLanguages!(r.repo, percents(l)))
        .catch(() => undefined)
  }

  async authOf(r: RemoteRec): Promise<ProviderAuth | null> {
    if (r.provider === 'github') {
      if (r.installation)
        return { kind: 'installation', installation: r.installation }
      const gh = this.deps.forges.github
      const inst = await gh?.installationOf?.(r.fullName)
      if (!inst) return null
      await this.store.patchRemote(r.id, { installation: inst })
      return { kind: 'installation', installation: inst }
    }
    if (!r.connectionId) return null
    const c = await this.store.connectionById(r.connectionId)
    return c ? this.userAuth(c) : null
  }

  async listConnections(p: Principal) {
    const out = []
    for (const c of await this.store.connections(p.handle))
      out.push(
        presentConnection(
          c,
          (await this.store.remotesOfConnection(c.id)).length,
        ),
      )
    return out
  }

  async listRepos(
    p: Principal,
    provider: ProviderId,
    body: {
      github_access?: string
      cursor?: string
      q?: string
      forks?: boolean
      archived?: boolean
    },
  ) {
    const forge = this.forge(provider)
    let auth: ProviderAuth
    if (provider === 'github') {
      if (!body.github_access || !this.deps.githubToken)
        throw apiError(
          'invalid_request',
          'Listing GitHub repositories needs `github_access`.',
        )
      auth = {
        kind: 'user',
        token: await this.deps.githubToken(body.github_access, p.handle),
      }
    } else {
      const c = await this.store.connection(p.handle, provider, forge.host)
      if (!c)
        throw apiError('invalid_state', `Connect ${hostLabel[provider]} first.`)
      auth = await this.userAuth(c)
    }
    const page = await forge
      .listRepos(auth, { cursor: body.cursor ?? null })
      .catch((e: unknown) => {
        throw this.providerProblem(e)
      })
    const q = body.q?.trim().toLowerCase()
    const items = page.items.filter(
      (r) =>
        ((body.forks ?? true) ? true : !r.fork) &&
        ((body.archived ?? true) ? true : !r.archived) &&
        (!q ||
          r.slug.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)),
    )
    const held = items.length
      ? await this.store.claims(
          provider,
          forge.host,
          items.map((r) => r.id),
        )
      : {}
    return {
      object: 'list' as const,
      data: items.map((r) => presentProviderRepo(r, held[r.id] ?? null)),
      has_more: page.next !== null,
      next_cursor: page.next,
    }
  }

  async oauthStartPresented(
    p: Principal,
    provider: ProviderId,
    redirectUri: string,
    returnTo: string | null,
  ) {
    const r = await this.connectStart(p, provider, redirectUri, returnTo)
    return { object: 'provider_oauth' as const, provider, url: r.url }
  }

  async oauthFinishPresented(
    p: Principal,
    provider: ProviderId,
    body: { code: string; state: string; redirect_uri: string },
  ) {
    const r = await this.connectFinish(p, provider, body)
    return {
      object: 'provider_oauth_result' as const,
      connection: presentConnection(
        r.connection,
        (await this.store.remotesOfConnection(r.connection.id)).length,
      ),
      return_to: r.returnTo,
    }
  }

  async linkOf(p: Principal | null, full: string) {
    const r = await this.store.remoteOfRepo(full)
    if (!r) throw apiError('not_found', `${full} is not linked to a provider.`)
    const connection = r.connectionId
      ? await this.store.connectionById(r.connectionId)
      : null
    const forge = this.deps.forges[r.provider]
    const mine =
      p && forge && r.provider !== 'github'
        ? await this.store.connection(p.handle, r.provider, forge.host)
        : null
    const adoptable = Boolean(
      mine &&
      mine.state === 'ok' &&
      (!connection || connection.state !== 'ok' || r.state === 'broken') &&
      mine.id !== connection?.id,
    )
    return presentLink(r, { forge, connection, adoptable })
  }

  async warningsFor(full: string) {
    const r = await this.store.remoteOfRepo(full)
    return r ? warningsOf(r, this.deps.forges[r.provider]) : []
  }

  async auditFor(p: Principal) {
    return (await this.store.auditOf(p.handle, 100)).map(presentAudit)
  }

  async batchPresented(
    p: Principal,
    body: Parameters<ProviderSync['startBatch']>[1],
  ) {
    return presentJob(await this.startBatch(p, body))
  }

  async jobPresented(p: Principal, id: string) {
    return presentJob(await this.job(p, id))
  }

  async startBatch(
    p: Principal,
    body: {
      provider: ProviderId
      slugs: Array<string>
      owner?: string
      visibility?: 'public' | 'private'
      github_access?: string
    },
  ) {
    const forge = this.forge(body.provider)
    const slugs = [...new Set(body.slugs.map((s) => s.trim()).filter(Boolean))]
    if (!slugs.length)
      throw apiError('invalid_request', 'Name at least one repository.')
    if (slugs.length > 500)
      throw apiError(
        'invalid_request',
        'At most 500 repositories in one import.',
      )
    let found: Map<string, RemoteRepo>
    let connection: ConnectionRec | null = null
    if (body.provider === 'github') {
      if (!body.github_access || !this.deps.githubToken)
        throw apiError(
          'invalid_request',
          'Importing from GitHub needs `github_access`.',
        )
      const token = await this.deps.githubToken(body.github_access, p.handle)
      const gh = forge as ForgeProvider & {
        pushable?: (t: string) => Promise<Map<string, RemoteRepo>>
      }
      found = await gh.pushable!(token).catch((e: unknown) => {
        throw this.providerProblem(e)
      })
    } else {
      connection = await this.store.connection(
        p.handle,
        body.provider,
        forge.host,
      )
      if (!connection)
        throw apiError(
          'invalid_state',
          `Connect ${hostLabel[body.provider]} first.`,
        )
      const auth = await this.userAuth(connection)
      found = new Map()
      for (const s of slugs) {
        const r = await forge.getRepo(auth, s).catch(() => null)
        if (r?.canPush) found.set(s.toLowerCase(), r)
      }
    }
    const missing = slugs.filter((s) => !found.has(s.toLowerCase()))
    if (missing.length)
      throw apiError(
        'forbidden',
        `You cannot push to ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''} on ${hostLabel[body.provider]}.`,
        {
          hint:
            body.provider === 'github'
              ? 'Install the Cobalt GitHub App on them, and make sure you can push to them.'
              : 'Only repositories you can push to can be linked.',
        },
      )
    const id = await this.store.createJob(
      {
        handle: p.handle,
        owner: body.owner ?? p.handle,
        provider: body.provider,
        instance: forge.host,
        connectionId: connection?.id ?? null,
        total: slugs.length,
        created: this.now(),
      },
      slugs.map((s) => {
        const r = found.get(s.toLowerCase())!
        return {
          externalId: r.id,
          slug: r.slug,
          name: r.slug.split('/').pop()!,
          visibility: body.visibility ?? (r.private ? 'private' : 'public'),
          defaultBranch: r.defaultBranch,
          installation: r.installation ?? null,
        }
      }),
    )
    return (await this.store.job(id))!
  }

  async job(p: Principal, id: string) {
    const j = await this.store.job(id).catch(() => null)
    if (!j || j.job.handle !== p.handle)
      throw apiError('not_found', `No import ${id}.`)
    return j
  }

  async runItem(item: JobItem, job: JobRec) {
    const forge = this.forge(job.provider)
    const p = delegated(job.handle, this.now())
    try {
      const held = await this.store.remoteByExternal(
        job.provider,
        job.instance,
        item.externalId,
      )
      if (held) {
        await this.store.finishItem(
          item.id,
          {
            state: 'skipped',
            repo: held.repo,
            error: `Already linked to ${held.repo}.`,
          },
          this.now(),
        )
        return
      }
      let auth: ProviderAuth
      let connection: ConnectionRec | null = null
      if (job.provider === 'github') {
        if (!item.installation)
          throw apiError(
            'invalid_state',
            'The GitHub App does not reach this repository.',
          )
        auth = { kind: 'installation', installation: item.installation }
      } else {
        connection = job.connectionId
          ? await this.store.connectionById(job.connectionId)
          : null
        if (!connection)
          throw apiError(
            'invalid_state',
            `The ${hostLabel[job.provider]} connection is gone.`,
          )
        auth = await this.userAuth(connection)
      }
      const remote = await forge.getRepo(auth, item.slug)
      const made = await this.need().importOne(
        p,
        {
          provider: job.provider,
          instance: job.instance,
          remote,
          connection,
          auth,
        },
        { owner: job.owner, name: item.name, visibility: item.visibility },
      )
      await this.store.finishItem(
        item.id,
        {
          state: made.created ? 'done' : 'skipped',
          repo: made.full,
          error: made.created ? null : 'Already here.',
        },
        this.now(),
      )
    } catch (e) {
      const busy =
        codeOf(e) === 'sync_in_progress' ||
        (statusOf(e) === 409 && /sync/.test(String((e as Error).message)))
      const transient =
        busy ||
        (e instanceof ProviderError && e.status >= 500) ||
        codeOf(e) === 'backend_unavailable'
      const message =
        (e as { detail?: string }).detail ??
        (e instanceof Error ? e.message : String(e))
      if (transient && item.attempts < ITEM_ATTEMPTS)
        await this.store.finishItem(
          item.id,
          {
            state: 'queued',
            error: message,
            retryAt: this.now() + 5_000 * 2 ** (item.attempts - 1),
          },
          this.now(),
        )
      else
        await this.store.finishItem(
          item.id,
          { state: 'failed', error: message },
          this.now(),
        )
    }
  }

  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private lastSweep = 0

  async tick(o: { concurrency?: number; staleEvery?: number } = {}) {
    if (this.ticking) return { items: 0, pulled: 0, swept: 0 }
    this.ticking = true
    try {
      const claimed = await this.store.claimItems(
        this.now(),
        ITEM_LEASE_MS,
        o.concurrency ?? 3,
      )
      await Promise.all(claimed.map(({ item, job }) => this.runItem(item, job)))
      for (const r of await this.store.itemsDue(this.now(), 2))
        await this.items.syncRepo(r).catch((e: unknown) => {
          this.deps.log?.({
            msg: 'items sync failed',
            repo: r.repo,
            error: String(e),
          })
          return this.store.setItemsDue(r.repo, this.now() + 30 * 60_000)
        })
      let pulled = 0
      let swept = 0
      if (this.now() - this.lastSweep >= (o.staleEvery ?? 10 * 60_000)) {
        this.lastSweep = this.now()
        for (const r of await this.store.stale(this.now() - STALE_MS, 20)) {
          // Items too: a link whose schedule was lost is read again.
          await this.store.setItemsDue(r.repo, this.now())
          await this.refreshMeta(r).catch(() => undefined)
          await this.pull(r).then(
            () => pulled++,
            (e: unknown) =>
              this.deps.log?.({
                msg: 'stale pull failed',
                repo: r.repo,
                error: String(e),
              }),
          )
        }
        swept = await this.sweep()
        await this.store.sweepDeliveries?.(this.now() - 7 * 86_400_000)
      }
      return { items: claimed.length, pulled, swept }
    } finally {
      this.ticking = false
    }
  }

  start(everyMs = 5_000) {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((e: unknown) =>
        this.deps.log?.({ msg: 'provider worker', error: String(e) }),
      )
    }, everyMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sweep() {
    const s = this.store
    if (!s.claimSweeps || !s.doneSweeps) return 0
    const done: Array<string> = []
    for (const job of await s.claimSweeps(this.now(), 20)) {
      try {
        await this.runSweep(JSON.parse(job.key) as SweepJob)
        done.push(job.id)
      } catch (e) {
        this.deps.log?.({ msg: 'provider sweep failed', error: String(e) })
      }
    }
    if (done.length) await s.doneSweeps(done)
    return done.length
  }

  async runSweep(job: SweepJob) {
    const forge = this.deps.forges[job.provider]
    const vault = await this.deps.vault
    if (job.kind === 'unhook') {
      const c = await this.store.connectionById(job.connectionId)
      const auth = c ? await this.userAuth(c).catch(() => null) : null
      if (forge && auth)
        await forge
          .deleteWebhook(auth, job.slug, job.webhookId)
          .catch(() => undefined)
      return
    }
    const token =
      job.token && vault
        ? await vault
            .open(
              {
                kind: 'providerConnection',
                id: job.connectionId,
                field: 'token',
              },
              job.token,
            )
            .catch(() => null)
        : null
    const auth: ProviderAuth | null = token ? { kind: 'user', token } : null
    for (const r of job.repos) {
      if (forge && auth && r.webhookId)
        await forge
          .deleteWebhook(auth, r.slug, r.webhookId)
          .catch(() => undefined)
      if (r.storeId && r.credentialId)
        await this.deps.git
          ?.deleteCredential(r.storeId, r.credentialId)
          .catch(() => undefined)
    }
    if (token)
      await this.deps.oauth[job.provider]?.revoke(token).catch(() => undefined)
  }
}

export type SweepJob =
  | {
      kind: 'unhook'
      connectionId: string
      provider: ProviderId
      slug: string
      webhookId: string
    }
  | {
      kind: 'disconnect'
      connectionId: string
      provider: ProviderId
      instance: string
      token: string | null
      refresh: string | null
      repos: Array<{
        storeId: string | null
        slug: string
        webhookId: string | null
        credentialId: string | null
      }>
    }

export const defaultHost: Record<ProviderId, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  codeberg: 'codeberg.org',
}
