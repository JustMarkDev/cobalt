import { Effect } from 'effect'
import { z } from 'zod'
import { Domain, defineOp } from '../registry'
import * as S from '../schemas'

const tags = ['imports']

export const githubDeviceStart = defineOp({
  id: 'github.device.start',
  summary: 'Start signing in with GitHub',
  description:
    'Gives a code to type at github.com/login/device. Then poll `github.device.poll` until it answers `authorized`.',
  tags,
  method: 'POST',
  path: '/github/device',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: false,
  response: S.GithubDevice,
  status: 201,
  errors: ['backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.githubDeviceStart(ctx.principal!))
    }),
})

export const githubDevicePoll = defineOp({
  id: 'github.device.poll',
  summary: 'Ask whether the GitHub sign-in is done',
  description:
    'When `authorized`, `access` proves who you are on GitHub for ten minutes. Nothing about it is stored here.',
  tags,
  method: 'POST',
  path: '/github/device/poll',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  body: z.strictObject({ device_code: z.string().min(1).max(200) }),
  response: S.GithubDeviceStatus,
  errors: ['backend_unavailable', 'invalid_request'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.githubDevicePoll(ctx.principal!, ctx.body.device_code),
      )
    }),
})

export const githubRepos = defineOp({
  id: 'github.repos.list',
  summary: 'The GitHub repositories you can import',
  description:
    'The repositories you may push to and that have the Cobalt GitHub App installed. Sent as a POST because `access` is a secret.',
  tags,
  method: 'POST',
  path: '/github/repos',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  body: z.strictObject({ access: z.string().min(1).max(4000) }),
  response: S.listOf(S.GithubRepo),
  errors: ['forbidden', 'backend_unavailable'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run((d) =>
        d.githubRepos(ctx.principal!, ctx.body.access),
      )
      return {
        object: 'list' as const,
        data,
        has_more: false as const,
        next_cursor: null,
      }
    }),
})

const callback = z
  .string()
  .url()
  .max(500)
  .refine((u) => new URL(u).pathname === '/github/callback', {
    message: "Must be this site's /github/callback address",
  })
  .describe("Where GitHub sends the person back: this site's /github/callback")

export const githubOauthStart = defineOp({
  id: 'github.oauth.start',
  summary: 'Start signing in with GitHub in the browser',
  description:
    'Gives the GitHub address to send the person to. GitHub sends them back to `redirect_uri` with a `code` and the `state`, which go to `github.oauth.finish` within ten minutes.',
  tags,
  method: 'POST',
  path: '/github/oauth',
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
  response: S.GithubOauth,
  status: 201,
  errors: ['backend_unavailable', 'invalid_request'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) =>
        d.githubOauthStart(
          ctx.principal!,
          ctx.body.redirect_uri,
          ctx.body.return_to ?? null,
        ),
      )
    }),
})

export const githubOauthFinish = defineOp({
  id: 'github.oauth.finish',
  summary: 'Finish signing in with GitHub in the browser',
  description:
    'Trades the `code` GitHub sent back for `access`, and links the GitHub account to yours as verified. A code works once.',
  tags,
  method: 'POST',
  path: '/github/oauth/finish',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: false,
  body: z.strictObject({
    code: z.string().min(1).max(200),
    state: z.string().min(1).max(2000),
    redirect_uri: callback,
  }),
  response: S.GithubOauthResult,
  errors: ['forbidden', 'backend_unavailable', 'invalid_request'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      return yield* run((d) => d.githubOauthFinish(ctx.principal!, ctx.body))
    }),
})

export const githubOps = [
  githubDeviceStart,
  githubDevicePoll,
  githubRepos,
  githubOauthStart,
  githubOauthFinish,
]
