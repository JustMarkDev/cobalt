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

export const githubOps = [githubDeviceStart, githubDevicePoll, githubRepos]
