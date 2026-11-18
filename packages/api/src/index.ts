import { SecretBox } from './secret-box'
import { mailerFromEnv } from './mail'
import type { Mailer } from './mail'
import { buildOpenApi } from './openapi'
import { createApi } from './pipeline'
import { EventLog } from './events'
import { MemoryDomain } from './domain'
import { changeOps } from './ops/changes'
import { tokenOps } from './ops/tokens'
import { webhookOps } from './ops/webhooks'
import { searchOps } from './ops/search'
import { uploadOps } from './ops/uploads'
import { extrasOps } from './ops/extras'
import { gitOps } from './ops/git'
import { teamOps } from './ops/teams'
import { timelineOps } from './ops/timelines'
import { presenceOps } from './ops/presence'
import { StoreGit } from './git'
import { ExtrasStore } from './extras'
import { SearchIndex } from './search'
import { HttpTransport, WebhookService } from './webhooks'
import { MemoryBlobStore, UploadService } from './uploads'
import { MemorySessions, OAuthServer } from './oauth'
import { oauthScopes } from './auth'
import { eventOps } from './ops/events'
import { issueOps } from './ops/issues'
import { notificationOps } from './ops/notifications'
import { releaseOps } from './ops/releases'
import { pipelineOps } from './ops/pipelines'
import { policyRuleOps } from './ops/policy-rules'
import { integrationOps } from './ops/integrations'
import { importOps } from './ops/imports'
import { insightOps } from './ops/insights'
import { peopleOps } from './ops/people'
import { metaOps, openapiOp } from './ops/meta'
import { repoOps } from './ops/repos'
import { T0, sampleTokenStore, seedSample } from './sample'
import { AuthStore } from './auth'
import type { Scope } from './auth'
import type { SessionResolver } from './oauth'
import type { OAuthState } from './oauth-state'
import { accountOps } from './ops/accounts'
import type { GitData } from './git'
import type { Scheduler, Transport } from './webhooks'
import type { Environment } from './extras'
import type { Op } from './registry'
import type { DomainPort } from './domain'
import type { Urls } from './domain/records'
import type { ApiOptions } from './pipeline'

/** Builds the domain the API runs on, from the seeded in-memory sample. */
export type DomainFactory = (from: {
  memory: MemoryDomain
  auth: AuthStore
  urls: Urls
  now: () => number
  events: EventLog
  /** How webhooks are sent, for a domain that sends them itself. */
  hooks: { transport: Transport; scheduler?: Scheduler; allowPrivate: boolean }
}) => DomainPort

/** Every operation. Adding an endpoint is adding one to a list in `ops/`. */
export const operations: ReadonlyArray<Op> = [
  ...metaOps,
  ...repoOps,
  ...changeOps,
  ...issueOps,
  ...eventOps,
  ...tokenOps,
  ...webhookOps,
  ...searchOps,
  ...uploadOps,
  ...extrasOps,
  ...gitOps,
  ...teamOps,
  ...timelineOps,
  ...presenceOps,
  ...accountOps,
  ...notificationOps,
  ...releaseOps,
  ...pipelineOps,
  ...policyRuleOps,
  ...integrationOps,
  ...importOps,
  ...insightOps,
  ...peopleOps,
]

export function allOperations(base?: string): Array<Op> {
  const list: Array<Op> = [...operations]
  list.push(openapiOp(() => buildOpenApi(list, base)))
  return list
}

export type { Api } from './pipeline'
export { createApi } from './pipeline'

/**
 * The API as the preview serves it: sample data, memory stores. Its `domain`
 * is the memory one, so tests and seeds can reach what `DomainPort` leaves out.
 */
export function createSampleApi(
  overrides: Omit<Partial<ApiOptions>, 'domain'> & {
    seed?: (d: MemoryDomain) => void
    /**
     * Builds the domain the API runs on from the seeded sample. Default: the
     * sample itself, in memory. Tests pass one that copies it into Convex.
     */
    domainFactory?: DomainFactory
    /** Offer sample accounts on the OAuth sign-in page. Default: true. */
    sampleLogins?: boolean
    /** The address people reach the app at, for OAuth. Default: the html base. */
    issuer?: string
    /** How webhooks are sent. Tests pass a fake; the default refuses private addresses. */
    transport?: Transport
    scheduler?: Scheduler
    allowPrivateWebhooks?: boolean
    /** Who is signed in on the OAuth pages. Default: the sample accounts. */
    sessions?: SessionResolver
    /** The most a signed-in person may delegate to a client. */
    userScopes?: (handle: string) => ReadonlyArray<Scope>
    /** Whether a machine sign-in may read secret values. Default: `SX_DEVICE_DECRYPT` is not `0`. */
    deviceDecrypt?: (handle: string) => boolean
    /** How email is sent. Default: written to the server log. */
    mail?: Mailer
    /** Where git data comes from. Default: the git store in `packages/git`. */
    git?: GitData
    /** The master key for secret values, base64. Default: `SX_SECRETS_KEY`. Without one the server keeps no values. */
    secretsKey?: string
    /**
     * Keep values under a key that dies with this process, when there is no
     * master key: tests, and the CLI's in-process preview on sample data.
     * Never a server: a restart would lose every value.
     */
    ephemeralSecrets?: boolean
  } = {},
) {
  const now = overrides.now ?? Date.now
  const urls = {
    api: overrides.base ?? 'https://api.source.code/v1',
    html: overrides.htmlBase ?? 'https://source.code',
  }
  const events = overrides.events ?? new EventLog(now)
  const domain = new MemoryDomain(urls, now, events)
  // The store reads the same clock as everything else. A clock frozen at
  // start would make every token minted later expire at start + its TTL.
  const auth =
    (overrides.tokens as AuthStore | undefined) ??
    sampleTokenStore(now(), new AuthStore(now))
  domain.svc.auth = auth
  domain.svc.hooks = new WebhookService({
    events,
    now,
    scheduler: overrides.scheduler,
    transport:
      overrides.transport ??
      new HttpTransport(overrides.allowPrivateWebhooks ?? false),
    allowPrivate: overrides.allowPrivateWebhooks ?? false,
  })
  domain.svc.search = new SearchIndex(() => domain.searchDocs(), events)
  domain.svc.uploads = new UploadService(new MemoryBlobStore(), now)
  domain.svc.extras = new ExtrasStore(now)
  // Without a master key the server keeps no values at all (fails closed),
  // unless it is a test or the in-process preview, which ask for a key that
  // lives as long as the process.
  domain.svc.secrets = SecretBox.fromBase64(
    overrides.secretsKey ?? process.env.SX_SECRETS_KEY,
  ).then(
    (box) => box ?? (overrides.ephemeralSecrets ? SecretBox.ephemeral() : null),
  )
  domain.svc.git = overrides.git ?? new StoreGit()
  domain.svc.mail = overrides.mail ?? mailerFromEnv()
  seedSample(domain)
  overrides.seed?.(domain)
  seedExtras(domain)
  domain.svc.secrets = domain.svc.secrets.then(async (box) => {
    if (box) await sealSampleValues(domain, box)
    return box
  })
  const port =
    overrides.domainFactory?.({
      memory: domain,
      auth,
      urls,
      now,
      events,
      hooks: {
        transport:
          overrides.transport ??
          new HttpTransport(overrides.allowPrivateWebhooks ?? false),
        scheduler: overrides.scheduler,
        allowPrivate: overrides.allowPrivateWebhooks ?? false,
      },
    }) ?? domain
  // The tokens the API checks are wherever the domain keeps them.
  const tokens = port.svc.auth
  const issuer = overrides.issuer ?? urls.html
  const oauth = new OAuthServer({
    auth: tokens,
    state: (port as { oauthState?: OAuthState }).oauthState,
    issuer,
    apiBase: urls.api,
    resources: { api: urls.api, mcp: `${urls.html}/mcp` },
    sessions:
      overrides.sessions ??
      new MemorySessions(
        overrides.sampleLogins === false
          ? []
          : [
              { handle: 'dana', name: 'Dana Okafor' },
              { handle: 'hollis', name: 'Hollis Reyes' },
            ],
        issuer.startsWith('https:'),
        now,
      ),
    deviceDecrypt:
      overrides.deviceDecrypt ?? (() => process.env.SX_DEVICE_DECRYPT !== '0'),
    userScopes:
      overrides.userScopes ??
      ((handle) =>
        handle === 'dana'
          ? oauthScopes
          : oauthScopes.filter(
              (s) => s !== 'repo:write' && s !== 'issues:write',
            )),
    now,
  })
  const api = createApi({
    ops: allOperations(urls.api),
    events,
    tokens,
    oauth,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource`,
    ...overrides,
    domain: port,
  })
  return { ...api, domain, port }
}

/**
 * Stand-in values for the sample's variables, sealed the way real ones are,
 * so reading them goes through every check a real read does.
 */
const SAMPLE_VALUES: Partial<Record<string, string>> = {
  DATABASE_URL: 'postgres://dev:hunter2-dev-only@localhost:5432/gitfs',
  STRIPE_KEY: 'sk_test_51MockMockMockMock9x',
  API_PORT: '8080',
}

async function sealSampleValues(d: MemoryDomain, box: SecretBox) {
  for (const r of d.repos.values()) {
    const x = (d.svc.extras as ExtrasStore).for(`${r.owner}/${r.name}`)
    for (const v of x.env)
      for (const environment of v.set) {
        const value = SAMPLE_VALUES[v.name]
        if (value === undefined) continue
        ;(x.sealed[v.name] ??= {})[environment] = await box.seal(
          { repoId: r.id, environment, name: v.name },
          value,
        )
      }
  }
}

/** Mirrors and environment schema for the sample repositories. */
function seedExtras(d: MemoryDomain) {
  for (const r of d.repos.values()) {
    const full = `${r.owner}/${r.name}`
    const x = (d.svc.extras as ExtrasStore).for(full)
    for (const v of r.env)
      x.env.push({
        name: v.name,
        kind: v.kind,
        secret: v.kind !== 'port',
        set: v.set as Array<Environment>,
        description: '',
      })
  }
  const x = (d.svc.extras as ExtrasStore).for('dana/gitfs')
  const at = T0 - 2 * 86_400_000
  const day = 86_400_000
  const describe: Record<string, [string, Array<Environment>, number, string]> =
    {
      DATABASE_URL: [
        'Postgres connection string',
        ['development', 'production'],
        12,
        'dana',
      ],
      STRIPE_KEY: [
        'Stripe secret key for billing',
        ['production'],
        0.2,
        'dana',
      ],
      API_PORT: [
        'Port the API listens on',
        ['development', 'production'],
        40,
        'hollis',
      ],
    }
  for (const v of x.env) {
    const known = describe[v.name] as (typeof describe)[string] | undefined
    if (!known) continue
    const [description, required, ago, by] = known
    v.description = description
    v.required = required
    v.rotated = { at: T0 - ago * day, by }
  }
  x.audit.push(
    {
      at: T0 - 0.12 * day,
      who: 'dana',
      action: 'Rotated',
      target: 'STRIPE_KEY in production',
      kind: 'rotate',
    },
    {
      at: T0 - 0.13 * day,
      who: 'production deploy',
      action: 'Decrypted',
      target: 'production for deploy run #812',
      kind: 'read',
    },
    {
      at: T0 - day,
      who: 'fix-agent',
      action: 'Was refused',
      target: 'production: agents cannot read it',
      kind: 'reject',
    },
  )
  x.mirrors.push(
    {
      id: 'mir_gitfsgithub0000000',
      host: 'github',
      slug: 'dana/gitfs',
      direction: 'two-way',
      state: 'in-sync',
      lastSync: at,
      detail: null,
      created: at - 86_400_000,
    },
    {
      id: 'mir_gitfsgitlab0000000',
      host: 'gitlab',
      slug: 'dana-labs/gitfs',
      direction: 'push',
      state: 'failing',
      lastSync: at - 86_400_000,
      detail: 'Authentication failed. Reconnect GitLab.',
      created: at - 86_400_000,
    },
  )
}
