import { SecretBox } from './secret-box'
import { ConvexClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { allOperations } from './index'
import { createApi } from './pipeline'
import { EventLog } from './events'
import { ConvexDomain, run } from './domain/convex'
import { OAuthServer } from './oauth'
import { oauthScopes } from './auth'
import { SearchIndex } from './search'
import { StoreGit } from './git'
import { HttpTransport } from './webhooks'
import { UploadSigner } from './uploads'
import { mailerFromEnv } from './mail'
import { convexHttpCall } from './stores/convex-http'
import { ConvexEventFeed } from './stores/convex-events'
import { ConvexOAuthState, ConvexTokens } from './stores/convex-tokens'
import { ConvexExtras } from './stores/convex-extras'
import { ConvexUploads } from './stores/convex-uploads'
import { ConvexHooks, followDeliveries } from './stores/convex-hooks'
import {
  ConvexIdempotencyStore,
  ConvexLimitStore,
  convexCaller,
} from './stores/convex'
import { blobStoreFromEnv } from './stores/blobs'
import { StoreWorker } from './stores/store-worker'
import { githubFromEnv } from './github'
import { providersFromEnv } from './forge/env'
import { createGitHttp } from './git-http'
import { codeStorageAdmin } from '@cobaltforge/git/admin'
import { codeStorageStores } from '@cobaltforge/git/stores'
import { codeStorageRemotes } from '@cobaltforge/git/remote'
import type { GitRemotes } from '@cobaltforge/git/remote'
import type { GitAdmin } from '@cobaltforge/git/admin'
import type { Attached } from './domain/records'
import type { SessionResolver } from './oauth'
import type { Scope } from './auth'
import type { JWK } from 'jose'

export type ConvexApiOptions = {
  convexUrl: string
  jwt: { issuer: string; privateJwk: JWK }
  storeSecret?: string
  uploadSecret: string
  mount: string
  base: string
  htmlBase: string
  sessions: SessionResolver
  userScopes?: (handle: string) => ReadonlyArray<Scope>
  deviceDecrypt?: (handle: string) => boolean
  seedSample?: () => string
  blobFolder: string
  gitAdmin?: GitAdmin
  gitRemotes?: GitRemotes
  env?: Record<string, string | undefined>
  allowPrivateWebhooks?: boolean
}

export function createConvexApi(o: ConvexApiOptions) {
  const now = Date.now
  const env = o.env ?? process.env
  const urls = { api: o.base, html: o.htmlBase }
  const call = convexHttpCall(o.convexUrl, o.jwt)
  const blobs = blobStoreFromEnv(env, o.blobFolder)
  const events = new EventLog(now)
  const svc = {
    auth: new ConvexTokens(call),
    extras: new ConvexExtras(call, now),
    secrets: SecretBox.fromBase64(env.CB_SECRETS_KEY),
    uploads: new ConvexUploads(
      call,
      blobs,
      new UploadSigner(Buffer.from(o.uploadSecret)),
      now,
    ),
    hooks: new ConvexHooks(call, {
      events,
      now,
      transport: new HttpTransport(o.allowPrivateWebhooks ?? false),
      allowPrivate: o.allowPrivateWebhooks ?? false,
    }),
    git: new StoreGit(undefined, codeStorageStores()),
    mail: mailerFromEnv(),
    github: githubFromEnv(env, o.storeSecret ?? env.CB_SECRETS_KEY),
  } as unknown as Attached
  const providers = providersFromEnv(env, {
    call,
    github: svc.github ?? null,
    git: (svc.git as StoreGit).upstreams,
    hookBase: `${o.htmlBase}/hooks`,
    stateKey: o.storeSecret ?? env.CB_SECRETS_KEY ?? null,
    now,
  })
  svc.providers = providers
  const d = new ConvexDomain(urls, call, events, svc, now)
  providers.attach(d.providerHost())
  ;(svc.git as StoreGit).resolveStore = (full) => d.storeIdOf(full)
  svc.search = new SearchIndex(() => d.searchDocs(), events)
  const domain = Object.assign(d, {
    oauthState: new ConvexOAuthState(call),
  })
  // A push starts the workflows it takes. Old pushes the feed replays on
  // start are left alone; queueing is once per workflow and commit anyway.
  events.subscribe((e) => {
    if (
      (e.type === 'change.opened' ||
        (e.type === 'change.updated' &&
          e.changes.includes('head.patch_set'))) &&
      e.repo &&
      e.subject.number !== null &&
      now() - Date.parse(e.created_at) < 10 * 60_000
    )
      void d
        .queueReview({ repo: e.repo, number: e.subject.number })
        .then((runs) => {
          if (runs.length)
            console.log(
              '[review]',
              JSON.stringify({ repo: e.repo, change: e.subject.number, runs }),
            )
        })
        .catch((err: unknown) =>
          console.error('[review] could not queue', e.repo, err),
        )
    if (e.type !== 'repository.pushed' || !e.repo) return
    if (now() - Date.parse(e.created_at) > 10 * 60_000) return
    const data = e.data as { ref?: string; after?: string } | null
    if (!data?.ref || !data.after) return
    void d
      .queueWorkflows({
        repo: e.repo,
        ref: data.ref,
        after: data.after,
        actor: e.actor.handle,
      })
      .then((runs) => {
        if (runs.length)
          console.log(
            '[pipelines]',
            JSON.stringify({ repo: e.repo, ref: data.ref, runs }),
          )
      })
      .catch((err: unknown) =>
        console.error('[pipelines] could not start workflows', e.repo, err),
      )
    void d
      .detectFacts({ repo: e.repo, ref: data.ref, after: data.after })
      .catch((err: unknown) =>
        console.error(
          '[repos] could not read languages and license',
          e.repo,
          err,
        ),
      )
  })
  const feed = new ConvexEventFeed(call, events, (rev) => {
    d.accessRevision = rev
  })

  const ready = (async () => {
    if (o.seedSample) {
      const seeded = await run<boolean>(
        call,
        'mutation',
        'seed:loadSample',
        { world: o.seedSample() },
        'system',
      )
      if (seeded)
        console.log('[api] seeded the Convex deployment with the sample')
    }
    if (o.storeSecret) {
      const git =
        o.gitAdmin ??
        (env.PIERRE_ORG && env.PIERRE_PRIVATE_KEY
          ? codeStorageAdmin({
              org: env.PIERRE_ORG,
              privateKey: env.PIERRE_PRIVATE_KEY,
            })
          : undefined)
      new StoreWorker({
        call: convexCaller(o.convexUrl),
        secret: o.storeSecret,
        ...(git ? { git } : {}),
        blobs,
        onError: (e) => console.error('[store-worker]', e),
      }).start()
    }
    providers.start()
    await feed.start()
    await d.refreshSearch()
    svc.search.ensure()
    const hooks = svc.hooks as ConvexHooks
    const client = new ConvexClient(o.convexUrl)
    client.setAuth(({ forceRefreshToken }) =>
      call.token('system', forceRefreshToken),
    )
    client.onUpdate(
      makeFunctionReference<'query'>('forge/events:head'),
      {},
      () => {
        void feed.pull().then(() => hooks.send())
      },
    )
    followDeliveries(
      (onAnswer, onError) =>
        client.onUpdate(
          makeFunctionReference<'query'>('forge/webhooks:nextDue'),
          {},
          (text: string) => onAnswer(JSON.parse(text) as number | null),
          (e) => {
            console.error('[api] cannot follow webhook deliveries; polling', e)
            onError()
          },
        ),
      () => hooks.send(),
    )
    const health = setInterval(
      () =>
        void d
          .flushHealth()
          .catch((e: unknown) =>
            console.error('[api] could not share health', e),
          ),
      60_000,
    )
    health.unref()
  })()

  const oauth = new OAuthServer({
    auth: svc.auth,
    state: domain.oauthState,
    issuer: o.htmlBase,
    apiBase: o.base,
    resources: { api: o.base, mcp: `${o.htmlBase}/mcp` },
    sessions: o.sessions,
    userScopes: o.userScopes ?? (() => oauthScopes),
    deviceDecrypt: o.deviceDecrypt ?? (() => env.CB_DEVICE_DECRYPT !== '0'),
    now,
  })
  const shared = o.storeSecret ? convexCaller(o.convexUrl) : null
  const api = createApi({
    ops: allOperations(o.base),
    events,
    tokens: svc.auth,
    oauth,
    resourceMetadataUrl: `${o.htmlBase}/.well-known/oauth-protected-resource`,
    mount: o.mount,
    base: o.base,
    htmlBase: o.htmlBase,
    domain,
    ...(shared && o.storeSecret
      ? {
          limitStore: new ConvexLimitStore(shared, o.storeSecret),
          idempotency: new ConvexIdempotencyStore(shared, o.storeSecret),
        }
      : {}),
  })
  const fetch = async (req: Request) => {
    await ready
    return api.fetch(req)
  }
  const fetchAs: typeof api.fetchAs = async (principal, req) => {
    await ready
    return api.fetchAs(principal, req)
  }
  const gitHttp = createGitHttp({
    verifyToken: api.verifyToken,
    domain,
    remotes: o.gitRemotes ?? codeStorageRemotes(),
    beforeGit: (full, write) => providers.beforeGit(full, write),
    afterPush: (at, updates) => d.recordPushes(at, updates),
    log: (line) => console.log('[git]', JSON.stringify(line)),
  })
  const serveGit = async (req: Request, ip?: string) => {
    await ready
    return gitHttp(req, ip)
  }
  const receiveHook = async (provider: string, req: Request) => {
    await ready
    return providers.receiveRequest(provider, req)
  }
  return {
    ...api,
    fetch,
    fetchAs,
    receiveHook,
    gitHttp: serveGit,
    domain,
    port: domain,
    ready,
  }
}
