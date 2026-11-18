import { canMove, grantLifecycle } from '../lifecycles'
import { Effect } from 'effect'
import { z } from 'zod'
import { ENVIRONMENTS } from '../extras'
import { apiError } from '../problem'
import { receiptFor } from '../receipt'
import { Domain, defineOp, reply } from '../registry'
import { iso } from '../domain'
import * as S from '../schemas'
import { repoParams } from './common'
import type {
  ConfirmationRec,
  Environment,
  MirrorRec,
  RepoExtras,
} from '../extras'
import type { Principal } from '../auth'
import type { DomainPort } from '../domain'

const environment = z.enum(ENVIRONMENTS)

// ---------------------------------------------------------------------------
// Repositories

export const createRepo = defineOp({
  id: 'repos.create',
  summary: 'Create a repository',
  description:
    'A bare name goes in the account you act as; set `owner` to use another. Naturally idempotent: asking for one that exists returns it with `Sx-Outcome: unchanged`. Members of an organization cannot create repositories there.',
  tags: ['repositories'],
  method: 'POST',
  path: '/repos',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  body: z.strictObject({
    name: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
        'Letters, digits, dot, dash and underscore; up to 100',
      ),
    owner: z
      .string()
      .optional()
      .describe('Account handle. Default: the account you act as'),
    description: z.string().max(500).optional(),
    visibility: z.enum(['public', 'private']).default('public'),
    maintainers: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'People who can approve core-path changes. A maintainer also has repository write access: adding one grants it, and removing one revokes the write access that maintainer list granted unless the person has another grant. Default: the account owners/admins and you.',
      ),
  }),
  response: S.Repo,
  status: 201,
  errors: ['forbidden', 'not_found'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const r = yield* run((d) =>
        d.createRepo(ctx.principal!, ctx.body, ctx.dryRun),
      )
      return reply(r.repo, {
        status: r.created ? 201 : 200,
        headers: {
          'sx-outcome': r.created ? 'created' : 'unchanged',
          ...(r.created ? { location: r.repo.url } : {}),
        },
      })
    }),
})

// ---------------------------------------------------------------------------
// Mirrors

const presentMirror = (
  d: DomainPort,
  full: string,
  m: MirrorRec,
): z.infer<typeof S.Mirror> => ({
  object: 'mirror',
  id: m.id,
  host: m.host,
  slug: m.slug,
  direction: m.direction,
  state: m.state,
  detail: m.detail,
  last_sync_at: iso(m.lastSync),
  url: `${d.urls.api}/repos/${full}/mirrors/${m.id}`,
  created_at: iso(m.created),
  paused: m.paused ?? false,
})

const mirrorParams = repoParams.extend({
  mirror: z.string().describe('The mirror `mir_` id'),
})
const hosts = [
  'github',
  'gitlab',
  'codeberg',
  'gitea',
  'forgejo',
  'bitbucket',
] as const

export const listMirrors = defineOp({
  id: 'mirrors.list',
  summary: 'Copies of the repository on other hosts',
  tags: ['mirrors'],
  method: 'GET',
  path: '/repos/{owner}/{repo}/mirrors',
  params: repoParams,
  auth: 'required',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  response: S.listOf(S.Mirror),
  errors: ['not_found', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run(async (d) => {
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'read',
        )
        return (await d.svc.extras.open(full)).mirrors.map((m) =>
          presentMirror(d, full, m),
        )
      })
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const createMirror = defineOp({
  id: 'mirrors.create',
  summary: 'Add a mirror',
  description:
    'Naturally idempotent: the same host and repository returns the existing mirror with `Sx-Outcome: unchanged`.',
  tags: ['mirrors'],
  method: 'POST',
  path: '/repos/{owner}/{repo}/mirrors',
  params: repoParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  body: z.strictObject({
    host: z.enum(hosts),
    slug: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/)
      .describe('`owner/name` on that host'),
    direction: z.enum(['push', 'pull', 'two-way']).default('push'),
  }),
  response: S.Mirror,
  status: 201,
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const out = yield* run(async (d) => {
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'write',
        )
        const x = await d.svc.extras.open(full)
        const same = x.mirrors.find(
          (m) => m.host === ctx.body.host && m.slug === ctx.body.slug,
        )
        if (same) return { m: presentMirror(d, full, same), created: false }
        const rec: MirrorRec = {
          id: `mir_${ctx.now().toString(36)}${x.mirrors.length}`
            .padEnd(22, '0')
            .slice(0, 22),
          host: ctx.body.host,
          slug: ctx.body.slug,
          direction: ctx.body.direction,
          state: 'in-sync',
          lastSync: ctx.now(),
          detail: null,
          created: ctx.now(),
        }
        if (!ctx.dryRun) x.mirrors.push(rec)
        return { m: presentMirror(d, full, rec), created: true }
      })
      return reply(out.m, {
        status: out.created ? 201 : 200,
        headers: { 'sx-outcome': out.created ? 'created' : 'unchanged' },
      })
    }),
})

export const syncMirror = defineOp({
  id: 'mirrors.sync',
  summary: 'Sync one mirror now',
  tags: ['mirrors'],
  method: 'POST',
  path: '/repos/{owner}/{repo}/mirrors/{mirror}/sync',
  params: mirrorParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  response: S.Mirror,
  errors: ['not_found', 'forbidden', 'invalid_state', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run(async (d) => {
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'write',
        )
        const m = (await d.svc.extras.open(full)).mirrors.find(
          (x) => x.id === ctx.params.mirror,
        )
        if (!m) throw apiError('not_found', `No mirror ${ctx.params.mirror}.`)
        if (m.paused)
          throw apiError('invalid_state', `${m.host} ${m.slug} is paused.`, {
            hint: 'Resume it first: PATCH the mirror with paused=false.',
          })
        if (!ctx.dryRun) {
          m.state = 'in-sync'
          m.lastSync = ctx.now()
          m.detail = null
        }
        const synced = ctx.dryRun
          ? {
              ...m,
              state: 'in-sync' as const,
              lastSync: ctx.now(),
              detail: null,
            }
          : m
        return presentMirror(d, full, synced)
      })
    }),
})

export const updateMirror = defineOp({
  id: 'mirrors.update',
  summary: 'Pause, resume or change the direction of a mirror',
  description:
    'A paused mirror sends and fetches nothing, and asking it to sync answers `invalid_state`. Resuming leaves it as it was; sync it to catch up.',
  tags: ['mirrors'],
  method: 'PATCH',
  path: '/repos/{owner}/{repo}/mirrors/{mirror}',
  params: mirrorParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  body: z.strictObject({
    paused: z.boolean().optional(),
    direction: z.enum(['push', 'pull', 'two-way']).optional(),
  }),
  response: S.Mirror,
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run(async (d) => {
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'write',
        )
        const m = (await d.svc.extras.open(full)).mirrors.find(
          (x) => x.id === ctx.params.mirror,
        )
        if (!m) throw apiError('not_found', `No mirror ${ctx.params.mirror}.`)
        const next = {
          ...m,
          paused: ctx.body.paused ?? m.paused,
          direction: ctx.body.direction ?? m.direction,
        }
        if (!ctx.dryRun) Object.assign(m, next)
        return presentMirror(d, full, next)
      })
    }),
})

export const deleteMirror = defineOp({
  id: 'mirrors.delete',
  summary: 'Remove a mirror',
  description: 'The copy on the other host is left as it is.',
  tags: ['mirrors'],
  method: 'DELETE',
  path: '/repos/{owner}/{repo}/mirrors/{mirror}',
  params: mirrorParams,
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'destructive',
  idempotent: false,
  dryRun: true,
  response: z.null(),
  status: 204,
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      yield* run(async (d) => {
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'write',
        )
        const x = await d.svc.extras.open(full)
        const i = x.mirrors.findIndex((m) => m.id === ctx.params.mirror)
        if (i < 0)
          throw apiError('not_found', `No mirror ${ctx.params.mirror}.`)
        if (!ctx.dryRun) x.mirrors.splice(i, 1)
      })
      return reply(null, { status: 204 })
    }),
})

// ---------------------------------------------------------------------------
// Environment variables, their values, and production confirmations

/** How long a production confirmation may be given for. */
const MAX_CONFIRM_MINUTES = 8 * 60

const confirmUrl = (d: DomainPort, full: string, id: string) =>
  `${d.urls.html}/${full}/settings?section=secrets&confirm=${id}`

const presentConfirmation = (
  d: DomainPort,
  full: string,
  c: ConfirmationRec,
  now: number,
): z.infer<typeof S.Confirmation> => ({
  object: 'confirmation',
  id: c.id,
  environment: c.environment,
  // A request nobody answered in time, or an answer past its time, is over.
  state:
    (c.state === 'pending' || c.state === 'active') && c.expires <= now
      ? 'expired'
      : c.state,
  login: c.handle,
  device: c.device,
  tool: c.tool,
  reason: c.reason,
  expires_at: iso(c.expires),
  confirm_url: confirmUrl(d, full, c.id),
  url: `${d.urls.api}/repos/${full}/env/confirmations/${c.id}`,
  created_at: iso(c.created),
})

/** Who did something with a value, as the audit log says it. */
const whoOf = (p: Principal) => {
  if (p.session) return `${p.handle} in the browser`
  const r = receiptFor(p)
  return `${p.handle} on ${r.machine ?? 'an unnamed machine'}${r.tool ? ` via ${r.tool}` : ''}${r.model ? ` (${r.model})` : ''}`
}

/** The box that seals values, or `secrets_unavailable` when the server has none. */
async function boxOf(d: DomainPort) {
  const box = await d.svc.secrets
  if (!box)
    throw apiError(
      'secrets_unavailable',
      'This server keeps no secret values: it has no secrets key.',
    )
  return box
}

/** The caller must be in the repository's team to touch values at all. */
async function teamOf(
  d: DomainPort,
  owner: string,
  name: string,
  p: Principal,
) {
  const access = await d.secretsAccess(owner, name, p)
  if (!access.team)
    throw apiError(
      'forbidden',
      "Only the repository's team can use its secret values.",
      {
        hint: 'The team is the owner (every member, for an organization) and teams with write access. Collaborators see names only.',
      },
    )
  return access
}

/**
 * Production values need a confirmation for this very login, given from a
 * signed-in page. Without one the request waits, and the caller gets a link
 * to confirm it.
 */
async function requireConfirmed(
  d: DomainPort,
  x: RepoExtras,
  full: string,
  p: Principal,
  env: Environment,
  now: number,
  ask = true,
): Promise<ConfirmationRec | null> {
  if (env !== 'production' || p.session) return null
  const ok = x.confirmed(p.loginId, env)
  if (ok) return ok
  // A dry run says it would be refused, and queues nothing for the person.
  if (!ask)
    throw apiError(
      'confirmation_required',
      `Production values need you to confirm this login (${p.device}) first.`,
      { hint: 'Run it for real to ask; sx prints where to confirm.' },
    )
  const { rec } = x.requestConfirmation({
    environment: env,
    handle: p.handle,
    tokenId: p.loginId,
    device: p.device,
    tool: receiptFor(p).tool,
    reason: null,
  })
  // The request is refused, but the question it asked must be kept, so the
  // person can answer it: saved before the refusal unwinds the request.
  await d.svc.extras.flush?.()
  throw apiError(
    'confirmation_required',
    `Production values need you to confirm this login (${p.device}) first.`,
    {
      hint: `Open ${confirmUrl(d, full, rec.id)} where you are signed in, confirm, then retry.`,
      extra: {
        confirmation: presentConfirmation(d, full, rec, now),
        confirm_url: confirmUrl(d, full, rec.id),
      },
    },
  )
}

const confirmationParams = repoParams.extend({
  confirmation: z.string().describe('The confirmation `cnf_` id'),
})
const schemaRead = {
  auth: 'required' as const,
  scopes: ['secrets:schema' as const],
  pool: 'read' as const,
  safety: 'read' as const,
  idempotent: true,
  tags: ['secrets'],
}

export const listEnv = defineOp({
  ...schemaRead,
  id: 'env.list',
  summary: 'Variable names, kinds and where they are set',
  description: 'Names and kinds only. A value is never in this answer.',
  method: 'GET',
  path: '/repos/{owner}/{repo}/env',
  params: repoParams,
  query: z.strictObject({
    environment: environment
      .optional()
      .describe('Also say whether each is set in this one'),
  }),
  response: S.listOf(S.EnvVar),
  errors: ['not_found', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run(async (d) => {
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'read',
        )
        return (await d.svc.extras.open(full)).env.map((v) => ({
          object: 'env_var' as const,
          name: v.name,
          kind: v.kind,
          secret: v.secret,
          description: v.description,
          environments: [...v.set],
          set: ctx.query.environment
            ? v.set.includes(ctx.query.environment)
            : null,
          required: [...(v.required ?? [])],
          rotated_at: v.rotated ? iso(v.rotated.at) : null,
          rotated_by: v.rotated?.by ?? null,
        }))
      })
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const setEnv = defineOp({
  id: 'env.set',
  summary: 'Set a variable in an environment',
  description:
    "Sealed the moment it arrives (AES-256-GCM, under a key that belongs to this repository and bound to this variable and environment) and never answered back. Only the repository's team may set values. Setting a production value from a token needs the same confirmation as reading one. The name must already be in the schema, so reviewers can see it exists. Takes no Idempotency-Key, since the body is a secret; setting the same value twice is harmless.",
  tags: ['secrets'],
  method: 'PUT',
  path: '/repos/{owner}/{repo}/env/{name}/{environment}',
  params: repoParams.extend({
    name: z.string().describe('The variable name'),
    environment,
  }),
  auth: 'required',
  scopes: ['secrets:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  secretRequest: true,
  body: z.strictObject({ value: z.string().min(1).max(65536) }),
  response: S.EnvVar,
  errors: [
    'not_found',
    'forbidden',
    'invalid_request',
    'confirmation_required',
    'secrets_unavailable',
    'moved',
  ],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run(async (d) => {
        const p = ctx.principal!
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          p,
          'write',
        )
        const box = await boxOf(d)
        const access = await teamOf(d, ctx.params.owner, ctx.params.repo, p)
        const x = await d.svc.extras.open(full)
        const v = x.env.find((e) => e.name === ctx.params.name)
        if (!v)
          throw apiError(
            'invalid_request',
            `${ctx.params.name} is not in the env schema.`,
            {
              hint: 'Add it to the schema first so reviewers can see it exists.',
              errors: [
                {
                  pointer: '/params/name',
                  code: 'not_in_schema',
                  message: 'Add it to .env.schema.',
                },
              ],
            },
          )
        await requireConfirmed(
          d,
          x,
          full,
          p,
          ctx.params.environment,
          ctx.now(),
          !ctx.dryRun,
        )
        if (!ctx.dryRun) {
          const first = !v.set.includes(ctx.params.environment)
          const sealed = await box.seal(
            {
              repoId: access.repoId,
              environment: ctx.params.environment,
              name: v.name,
            },
            ctx.body.value,
          )
          // Sealing waited: if the repository changed hands meanwhile, the
          // value is the old team's, and must not land in the new owner's.
          const still = await teamOf(d, ctx.params.owner, ctx.params.repo, p)
          if (still.repoId !== access.repoId || still.full !== access.full)
            throw apiError(
              'invalid_state',
              'The repository moved while the value was being set. Nothing was kept.',
            )
          ;(x.sealed[v.name] ??= {})[ctx.params.environment] = sealed
          if (first) v.set.push(ctx.params.environment)
          v.rotated = { at: ctx.now(), by: p.handle }
          x.note(
            whoOf(p),
            `${first ? 'set' : 'rotated'} ${v.name} (${ctx.params.environment})`,
            {
              target: `${v.name} in ${ctx.params.environment}`,
              kind: 'rotate',
            },
          )
          if (first) await d.bumpRepo(ctx.params.owner, ctx.params.repo, p)
        }
        return {
          object: 'env_var' as const,
          name: v.name,
          kind: v.kind,
          secret: v.secret,
          description: v.description,
          environments:
            ctx.dryRun && !v.set.includes(ctx.params.environment)
              ? [...v.set, ctx.params.environment]
              : [...v.set],
          set: ctx.dryRun || v.set.includes(ctx.params.environment),
          required: [...(v.required ?? [])],
          rotated_at: v.rotated ? iso(v.rotated.at) : null,
          rotated_by: v.rotated?.by ?? null,
        }
      })
    }),
})

export const envValues = defineOp({
  id: 'env.values',
  summary: 'Read values',
  description:
    "The only place a value leaves. Only the repository's team may read values: the account that owns it and teams with write access. Production values need a confirmation for this very login, given from a signed-in page (`confirmation_required` says where); other environments need none. A signed-in page never gets values, only tokens do, so a script running in a page cannot read them. Every read is written to the audit log with the machine, tool and model of the request. The answer is never cached or kept.",
  tags: ['secrets'],
  method: 'GET',
  path: '/repos/{owner}/{repo}/env/{environment}/values',
  params: repoParams.extend({ environment }),
  query: z.strictObject({
    names: z
      .string()
      .optional()
      .describe('Comma list. Default: every variable set here'),
    check_only: z
      .enum(['true', 'false'])
      .optional()
      .describe('Check access without reading or auditing values'),
  }),
  auth: 'required',
  scopes: ['secrets:decrypt'],
  conditional: false,
  secretResponse: true,
  pool: 'write',
  safety: 'read',
  idempotent: false,
  response: S.EnvValues,
  errors: [
    'not_found',
    'forbidden',
    'confirmation_required',
    'secrets_unavailable',
    'moved',
  ],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const out = yield* run(async (d) => {
        const p = ctx.principal!
        if (p.session)
          throw apiError(
            'forbidden',
            'Values are never given to a page in a browser.',
            {
              hint: 'Use sx env run or a token on the machine that needs them.',
            },
          )
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          p,
          'read',
        )
        const box = await boxOf(d)
        const access = await teamOf(d, ctx.params.owner, ctx.params.repo, p)
        const x = await d.svc.extras.open(full)
        const confirmed = await requireConfirmed(
          d,
          x,
          full,
          p,
          ctx.params.environment,
          ctx.now(),
          ctx.query.check_only !== 'true',
        )
        if (ctx.query.check_only === 'true')
          return {
            object: 'env_values' as const,
            environment: ctx.params.environment,
            values: {},
            secrets: [],
            confirmation: confirmed?.id ?? null,
          }
        const names = ctx.query.names?.split(',').filter(Boolean)
        const values: Record<string, string> = {}
        const secrets: Array<string> = []
        let unopened = 0
        for (const v of x.sealedFor(ctx.params.environment, names)) {
          const value = await box.open(
            {
              repoId: access.repoId,
              environment: ctx.params.environment,
              name: v.name,
            },
            v.sealed,
          )
          // A seal that does not open here (moved, tampered with, or sealed
          // under another key) is left out, never guessed at.
          if (value === null) {
            unopened++
            continue
          }
          values[v.name] = value
          if (v.secret) secrets.push(v.name)
        }
        x.note(
          whoOf(p),
          `read ${Object.keys(values).length} variable${Object.keys(values).length === 1 ? '' : 's'} (${ctx.params.environment})${confirmed ? ` under ${confirmed.id}` : ''}`,
          { target: ctx.params.environment, kind: 'read' },
        )
        if (unopened)
          x.note(
            whoOf(p),
            `${unopened} sealed value${unopened === 1 ? '' : 's'} in ${ctx.params.environment} did not open and were left out`,
            { target: ctx.params.environment, kind: 'reject' },
          )
        return {
          object: 'env_values' as const,
          environment: ctx.params.environment,
          values,
          secrets,
          confirmation: confirmed?.id ?? null,
        }
      })
      return reply(out, { headers: { 'cache-control': 'no-store' } })
    }),
})

export const listConfirmations = defineOp({
  ...schemaRead,
  id: 'confirmations.list',
  summary: 'Your requests to use production values, and their answers',
  description:
    'Only your own: whose login asked, from which machine, and until when an answer holds.',
  method: 'GET',
  path: '/repos/{owner}/{repo}/env/confirmations',
  params: repoParams,
  conditional: false,
  response: S.listOf(S.Confirmation),
  errors: ['not_found', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run(async (d) => {
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'read',
        )
        return (await d.svc.extras.open(full)).confirmations
          .filter((c) => c.handle === ctx.principal!.handle)
          .map((c) => presentConfirmation(d, full, c, ctx.now()))
      })
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const confirmConfirmation = defineOp({
  id: 'confirmations.confirm',
  summary: 'Confirm a login may use production values',
  description: `Only from a signed-in page, and only by the person whose login asked: a token can confirm nothing, not even its own request, so an agent holding your token cannot let itself in. Holds for up to ${MAX_CONFIRM_MINUTES / 60} hours, for that one login.`,
  tags: ['secrets'],
  method: 'POST',
  path: '/repos/{owner}/{repo}/env/confirmations/{confirmation}/confirm',
  params: confirmationParams,
  auth: 'required',
  scopes: ['secrets:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  body: z.strictObject({
    ttl_minutes: z.number().int().min(1).max(MAX_CONFIRM_MINUTES).default(60),
  }),
  response: S.Confirmation,
  errors: [
    'not_found',
    'forbidden',
    'session_required',
    'invalid_state',
    'moved',
  ],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run(async (d) => {
        const p = ctx.principal!
        if (!p.session)
          throw apiError(
            'session_required',
            'A token cannot confirm production access, not even its own.',
          )
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          p,
          'read',
        )
        await teamOf(d, ctx.params.owner, ctx.params.repo, p)
        const x = await d.svc.extras.open(full)
        const c = x.confirmations.find(
          (e) => e.id === ctx.params.confirmation && e.handle === p.handle,
        )
        // Someone else's request answers 404: only its owner may see or confirm it.
        if (!c)
          throw apiError(
            'not_found',
            `No confirmation ${ctx.params.confirmation}.`,
          )
        const now = ctx.now()
        if (c.state === 'active' && c.expires > now)
          return presentConfirmation(d, full, c, now)
        if (c.state !== 'pending' || c.expires <= now)
          throw apiError(
            'invalid_state',
            'That request is over. Ask again from the machine that needs the values.',
          )
        if (!canMove(grantLifecycle, c.state, 'active'))
          throw apiError('invalid_state', 'That request was revoked.')
        const answered = {
          ...c,
          state: 'active' as const,
          expires: now + ctx.body.ttl_minutes * 60_000,
        }
        if (!ctx.dryRun) {
          Object.assign(c, answered)
          x.note(
            whoOf(p),
            `confirmed ${c.environment} values for ${c.device} (${ctx.body.ttl_minutes} minutes)`,
            { target: c.environment, kind: 'grant' },
          )
        }
        return presentConfirmation(d, full, answered, now)
      })
    }),
})

export const revokeConfirmation = defineOp({
  id: 'confirmations.revoke',
  summary: 'End a confirmation, or turn down a request',
  description:
    'Takes effect at once, from anywhere. Only the person whose login it is: to cut off a machine entirely, sign it out in settings.',
  tags: ['secrets'],
  method: 'POST',
  path: '/repos/{owner}/{repo}/env/confirmations/{confirmation}/revoke',
  params: confirmationParams,
  auth: 'required',
  scopes: ['secrets:write'],
  pool: 'write',
  safety: 'destructive',
  idempotent: true,
  dryRun: true,
  response: S.Confirmation,
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run(async (d) => {
        const p = ctx.principal!
        const full = await d.repoAccessStrict(
          ctx.params.owner,
          ctx.params.repo,
          p,
          'read',
        )
        const x = await d.svc.extras.open(full)
        // Only the person whose login it is: anyone else's is not there. Any of
        // their own logins may end it (one machine can cut off another of
        // theirs), which only ever takes access away.
        const c = x.confirmations.find(
          (e) => e.id === ctx.params.confirmation && e.handle === p.handle,
        )
        if (!c)
          throw apiError(
            'not_found',
            `No confirmation ${ctx.params.confirmation}.`,
          )
        const revoked = { ...c, state: 'revoked' as const }
        if (!ctx.dryRun && canMove(grantLifecycle, c.state, 'revoked')) {
          c.state = 'revoked'
          x.note(whoOf(p), `ended ${c.id} (${c.device})`, {
            target: c.environment,
            kind: 'revoke',
          })
        }
        return presentConfirmation(d, full, ctx.dryRun ? revoked : c, ctx.now())
      })
    }),
})

export const envAudit = defineOp({
  ...schemaRead,
  id: 'env.audit',
  summary: 'Who did what with values',
  description:
    'Newest first, the last 200 entries, each with the machine, tool and model of the request.',
  method: 'GET',
  path: '/repos/{owner}/{repo}/env/audit',
  params: repoParams,
  response: S.listOf(S.AuditEntry),
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run(async (d) => {
        const full = await d.repoAccess(
          ctx.params.owner,
          ctx.params.repo,
          ctx.principal,
          'write',
        )
        // Who read which values, from where: the team's business only.
        await teamOf(d, ctx.params.owner, ctx.params.repo, ctx.principal!)
        return (await d.svc.extras.open(full)).audit.slice(0, 200).map((a) => ({
          object: 'audit_entry' as const,
          at: iso(a.at),
          who: a.who,
          action: a.action,
          target: a.target ?? null,
          kind: a.kind ?? null,
        }))
      })
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const extrasOps = [
  createRepo,
  listMirrors,
  createMirror,
  syncMirror,
  updateMirror,
  deleteMirror,
  listEnv,
  setEnv,
  envValues,
  listConfirmations,
  confirmConfirmation,
  revokeConfirmation,
  envAudit,
]
