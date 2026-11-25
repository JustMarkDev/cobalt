import { Effect } from 'effect'
import { z } from 'zod'
import { Domain, defineOp, reply } from '../registry'
import * as S from '../schemas'
import { repoParams } from './common'

const provider = z
  .enum(['github', 'gitlab', 'codeberg'])
  .describe('The git provider')
const oauthProvider = z
  .enum(['gitlab', 'codeberg'])
  .describe('GitHub signs in with `github.oauth.start` instead')
const tags = ['imports']
const access = z
  .string()
  .min(1)
  .max(4000)
  .optional()
  .describe(
    'For GitHub: the `access` from signing in with GitHub (`github.device.poll`)',
  )
const many = <T>(data: Array<T>) => ({
  object: 'list' as const,
  data,
  has_more: false as const,
  next_cursor: null,
})
const number = z.coerce.number().int().min(1).max(1e9)

export const listConnections = defineOp({
  id: 'providers.list',
  summary: 'Your accounts on git providers',
  description:
    'The GitLab and Codeberg accounts you connected with OAuth, and the GitHub account you signed in with. Each says how many repositories here sync through it.',
  tags,
  method: 'GET',
  path: '/providers',
  auth: 'required',
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.listOf(S.ProviderConnection),
  errors: ['backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return many(yield* run((d) => d.providerConnections(ctx.principal!)))
    }),
})

export const listProviderRepos = defineOp({
  id: 'providers.repos.list',
  summary: 'The repositories you can import from a provider',
  description:
    'A page of the repositories your account there can see, with whether you can push to each and whether one here already holds it. On GitHub, the repositories the Cobalt GitHub App is installed on, every page of every installation. Filter by text with `q`, and leave out forks or archived ones. Sent as a POST because `github_access` is a secret.',
  tags,
  method: 'POST',
  path: '/providers/{provider}/repos',
  params: z.object({ provider }),
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  body: z.strictObject({
    github_access: access,
    cursor: z
      .string()
      .max(2000)
      .optional()
      .describe('`next_cursor` from the previous page'),
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Text in the name or description'),
    forks: z
      .boolean()
      .optional()
      .describe('Default true; false leaves forks out'),
    archived: z
      .boolean()
      .optional()
      .describe('Default true; false leaves archived repositories out'),
  }),
  response: S.ProviderRepoPage,
  errors: ['forbidden', 'invalid_state', 'backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.providerRepos(ctx.principal!, ctx.params.provider, ctx.body),
      )
    }),
})

const callback = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^\/(gitlab|codeberg)\/callback$/.test(new URL(u).pathname), {
    message:
      "Must be this site's /gitlab/callback or /codeberg/callback address",
  })
  .describe(
    "Where the provider sends the person back: this site's /gitlab/callback or /codeberg/callback",
  )

export const providerOauthStart = defineOp({
  id: 'providers.oauth.start',
  summary: 'Start connecting GitLab or Codeberg',
  description:
    'Gives the address to send the person to. The provider sends them back to `redirect_uri` with a `code` and the `state`, which go to `providers.oauth.finish` within ten minutes. GitLab asks for the `api` scope, which repository webhooks need: the token is sealed at rest and revoked when you disconnect.',
  tags,
  method: 'POST',
  path: '/providers/{provider}/oauth',
  params: z.object({ provider: oauthProvider }),
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: false,
  body: z.strictObject({
    redirect_uri: callback,
    return_to: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)/, 'A path on this site')
      .optional()
      .describe('A path on this site to come back to afterwards'),
  }),
  response: S.ProviderOauth,
  status: 201,
  errors: ['backend_unavailable', 'invalid_request'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.providerOauthStart(
          ctx.principal!,
          ctx.params.provider,
          ctx.body.redirect_uri,
          ctx.body.return_to ?? null,
        ),
      )
    }),
})

export const providerOauthFinish = defineOp({
  id: 'providers.oauth.finish',
  summary: 'Finish connecting GitLab or Codeberg',
  description:
    'Trades the `code` the provider sent back for a token, which is kept sealed here and refreshed when it is about to expire. Connecting again replaces the token and resumes repositories that had stopped syncing.',
  tags,
  method: 'POST',
  path: '/providers/{provider}/oauth/finish',
  params: z.object({ provider: oauthProvider }),
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: false,
  body: z.strictObject({
    code: z.string().min(1).max(500),
    state: z.string().min(1).max(2000),
    redirect_uri: callback,
  }),
  response: S.ProviderOauthResult,
  errors: ['forbidden', 'invalid_state', 'backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.providerOauthFinish(ctx.principal!, ctx.params.provider, ctx.body),
      )
    }),
})

export const providerDisconnect = defineOp({
  id: 'providers.disconnect',
  summary: 'Disconnect a provider account',
  description:
    'Revokes the token at the provider, removes the webhooks and git credentials Cobalt made with it, and unlinks the repositories that synced through it. Their history here stays.',
  tags,
  method: 'DELETE',
  path: '/providers/{provider}',
  params: z.object({ provider }),
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'destructive',
  idempotent: true,
  dryRun: true,
  response: z.null(),
  status: 204,
  errors: ['not_found', 'backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      yield* run((d) =>
        d.providerDisconnect(ctx.principal!, ctx.params.provider, ctx.dryRun),
      )
      return reply(null, { status: 204 })
    }),
})

export const providerAudit = defineOp({
  id: 'providers.audit',
  summary: 'What you connected, imported and unlinked',
  description:
    'The last hundred connections, imports, adoptions, relinks and disconnections you made, newest first.',
  tags,
  method: 'GET',
  path: '/providers/audit',
  auth: 'required',
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.listOf(S.ProviderAudit),
  errors: ['backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return many(yield* run((d) => d.providerAudit(ctx.principal!)))
    }),
})

export const importBatch = defineOp({
  id: 'imports.batch',
  summary: 'Import many repositories at once',
  description:
    'Checks that you can push to every one (on GitHub, in one pass over your installations), then imports them a few at a time in the background. Each becomes a repository here linked two ways to its provider, named as it is there. Follow it with `imports.jobs.get`.',
  tags,
  method: 'POST',
  path: '/imports/batch',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: false,
  cost: 10,
  body: z.strictObject({
    provider,
    slugs: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, 'owner/name there'),
      )
      .min(1)
      .max(500),
    owner: z.string().optional().describe('Default: the account you act as'),
    visibility: z
      .enum(['public', 'private'])
      .optional()
      .describe('Default: as each is on the provider'),
    github_access: access,
  }),
  response: S.ImportJob,
  status: 202,
  errors: [
    'forbidden',
    'invalid_state',
    'invalid_request',
    'backend_unavailable',
  ],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const job = yield* run((d) => d.importBatch(ctx.principal!, ctx.body))
      return reply(job, { status: 202 })
    }),
})

export const importJob = defineOp({
  id: 'imports.jobs.get',
  summary: 'How a bulk import is going',
  tags,
  method: 'GET',
  path: '/imports/jobs/{id}',
  params: z.object({ id: z.string().max(100) }),
  auth: 'required',
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.ImportJob,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.importJob(ctx.principal!, ctx.params.id))
    }),
})

export const getProviderLink = defineOp({
  id: 'repos.provider.get',
  summary: 'The provider a repository is linked to',
  description:
    'How the link is doing, who keeps it in sync, and what to know: anyone who can write here can push there through Cobalt, the provider still applies its branch protection, Git LFS objects do not travel outside GitHub.',
  tags,
  method: 'GET',
  path: '/repos/{owner}/{repo}/provider',
  params: repoParams,
  auth: 'required',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.ProviderLink,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.repoProvider(ctx.params.owner, ctx.params.repo, ctx.principal),
      )
    }),
})

export const adoptProviderLink = defineOp({
  id: 'repos.provider.adopt',
  summary: 'Take over the link with your own connection',
  description:
    'For an admin of the repository, when the person whose GitLab or Codeberg account kept it in sync disconnected, lost access or was deleted. Your connection must be able to push to it there. Webhook and git credential are made again with your token.',
  tags,
  method: 'POST',
  path: '/repos/{owner}/{repo}/provider/adopt',
  params: repoParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  response: S.ProviderLink,
  errors: ['not_found', 'forbidden', 'invalid_state', 'backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.adoptProvider(
          ctx.principal!,
          ctx.params.owner,
          ctx.params.repo,
          ctx.dryRun,
        ),
      )
    }),
})

export const refreshProviderLink = defineOp({
  id: 'repos.provider.refresh',
  summary: 'Read pull requests, issues and releases again',
  description:
    'Asks for the provider’s pull requests, issues and releases to be read again soon. Webhooks keep them current; this is for when one was missed.',
  tags,
  method: 'POST',
  path: '/repos/{owner}/{repo}/provider/refresh',
  params: repoParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  response: S.ProviderLink,
  status: 202,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const link = yield* run((d) =>
        d.refreshProvider(
          ctx.principal!,
          ctx.params.owner,
          ctx.params.repo,
          ctx.dryRun,
        ),
      )
      return reply(link, { status: 202 })
    }),
})

const readOnly =
  'Read-only: a copy of what the provider holds, kept current by its webhooks.'

const listRemote = (
  id: string,
  path: string,
  kind: 'pull' | 'issue' | 'release',
  summary: string,
  item: z.ZodType,
) =>
  defineOp({
    id,
    summary,
    description: `${readOnly} The 200 most recently updated, newest first. Authors are people on the provider, not accounts here.`,
    tags,
    method: 'GET',
    path: `/repos/{owner}/{repo}/provider/${path}`,
    params: repoParams,
    auth: 'required',
    scopes: ['repo:read'],
    pool: 'read',
    safety: 'read',
    idempotent: true,
    response: S.listOf(item),
    errors: ['not_found'],
    handler: (ctx) =>
      Effect.gen(function* () {
        const { run } = yield* Domain
        return yield* run((d) =>
          d.remoteList(ctx.params.owner, ctx.params.repo, ctx.principal, kind),
        )
      }),
  })

export const listRemotePulls = listRemote(
  'repos.provider.pulls.list',
  'pulls',
  'pull',
  'Pull requests from the provider',
  S.RemotePull,
)
export const listRemoteIssues = listRemote(
  'repos.provider.issues.list',
  'issues',
  'issue',
  'Issues from the provider',
  S.RemoteIssue,
)
export const listRemoteReleases = listRemote(
  'repos.provider.releases.list',
  'releases',
  'release',
  'Releases from the provider',
  S.RemoteRelease,
)

export const getRemotePull = defineOp({
  id: 'repos.provider.pulls.get',
  summary: 'A pull request from the provider',
  description: `${readOnly} States in the words of changes here: merged is landed, closed is abandoned. When its head commit is not in this repository (a fork, or a branch deleted before it synced), its patch is kept: \`repos.provider.pulls.patch\`.`,
  tags,
  method: 'GET',
  path: '/repos/{owner}/{repo}/provider/pulls/{number}',
  params: repoParams.extend({ number }),
  auth: 'required',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.RemotePull,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.remotePull(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          ctx.params.number,
        ),
      )
    }),
})

export const getRemoteIssue = defineOp({
  id: 'repos.provider.issues.get',
  summary: 'An issue from the provider',
  description: readOnly,
  tags,
  method: 'GET',
  path: '/repos/{owner}/{repo}/provider/issues/{number}',
  params: repoParams.extend({ number }),
  auth: 'required',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.RemoteIssue,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.remoteIssue(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          ctx.params.number,
        ),
      )
    }),
})

const comments = (
  id: string,
  path: string,
  kind: 'pull' | 'issue',
  summary: string,
) =>
  defineOp({
    id,
    summary,
    description: `${readOnly} Oldest first; one removed on the provider stays, marked.`,
    tags,
    method: 'GET',
    path: `/repos/{owner}/{repo}/provider/${path}/{number}/comments`,
    params: repoParams.extend({ number }),
    auth: 'required',
    scopes: ['repo:read'],
    pool: 'read',
    safety: 'read',
    idempotent: true,
    response: S.listOf(S.RemoteComment),
    errors: ['not_found'],
    handler: (ctx) =>
      Effect.gen(function* () {
        const { run } = yield* Domain
        return yield* run((d) =>
          d.remoteComments(
            ctx.params.owner,
            ctx.params.repo,
            ctx.principal,
            kind,
            ctx.params.number,
          ),
        )
      }),
  })

export const listRemotePullComments = comments(
  'repos.provider.pulls.comments',
  'pulls',
  'pull',
  'Comments on a pull request from the provider',
)
export const listRemoteIssueComments = comments(
  'repos.provider.issues.comments',
  'issues',
  'issue',
  'Comments on an issue from the provider',
)

export const getRemotePatch = defineOp({
  id: 'repos.provider.pulls.patch',
  summary: 'The kept patch of a pull request',
  description:
    'For a pull request whose head commit is not in this repository: its patch as the provider gave it, cut at 900 KB. `not_found` when the commits are here, in which case read them from git.',
  tags,
  method: 'GET',
  path: '/repos/{owner}/{repo}/provider/pulls/{number}/patch',
  params: repoParams.extend({ number }),
  auth: 'required',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.RemotePatch,
  errors: ['not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.remotePatch(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          ctx.params.number,
        ),
      )
    }),
})

export const providerOps = [
  listConnections,
  providerAudit,
  listProviderRepos,
  providerOauthStart,
  providerOauthFinish,
  providerDisconnect,
  importBatch,
  importJob,
  getProviderLink,
  adoptProviderLink,
  refreshProviderLink,
  listRemotePulls,
  getRemotePull,
  getRemotePatch,
  listRemotePullComments,
  listRemoteIssues,
  getRemoteIssue,
  listRemoteIssueComments,
  listRemoteReleases,
]
