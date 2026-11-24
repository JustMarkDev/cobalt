import { Effect } from 'effect'
import { z } from 'zod'
import { MAX_RULE_PATTERNS, MAX_RULE_READERS } from '../access-rules'
import { Domain, defineOp, reply } from '../registry'
import * as S from '../schemas'
import { repoParams } from './common'

const ruleParams = repoParams.extend({
  rule: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe('The rule id: lowercase letters, digits and dashes'),
})

export const listAccessRules = defineOp({
  id: 'access_rules.list',
  summary: 'Branches and paths only some people may see',
  description:
    "An administrator sees every rule; someone a rule names sees that rule; anyone else sees none, and the parts the rules hide answer `404` to them everywhere: the repository's files, its changes, search, events and notifications.",
  tags: ['repos'],
  method: 'GET',
  path: '/repos/{owner}/{repo}/access-rules',
  auth: 'optional',
  scopes: ['repo:read'],
  pool: 'read',
  safety: 'read',
  idempotent: true,
  params: repoParams,
  response: S.listOf(S.AccessRule),
  errors: ['not_found', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const data = yield* run((d) =>
        d.listAccessRules(ctx.params.owner, ctx.params.repo, ctx.principal),
      )
      return {
        object: 'list' as const,
        data,
        has_more: false,
        next_cursor: null,
      }
    }),
})

export const putAccessRule = defineOp({
  id: 'access_rules.put',
  summary: 'Make branches or paths private to some people',
  description: `Creates the rule, or replaces it. \`kind: branch\` hides branches matching \`patterns\` (\`secret/*\`) and the changes on them; \`kind: path\` hides files matching \`patterns\` (\`finance/**\`, \`*.key\`) and every change touching one. \`readers\` are handles and \`team:<slug>\`; the repository's owners and admins always read everything, and a rule cannot hide the default branch. Someone who does not read a rule cannot see, open, push to or edit what it hides. Only an owner or admin. At most 20 rules, ${MAX_RULE_PATTERNS} patterns and ${MAX_RULE_READERS} readers each.`,
  tags: ['repos'],
  method: 'PUT',
  path: '/repos/{owner}/{repo}/access-rules/{rule}',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'write',
  idempotent: true,
  dryRun: true,
  params: ruleParams,
  body: z.strictObject({
    kind: z.enum(['branch', 'path']),
    patterns: z.array(z.string().min(1).max(200)).min(1).max(MAX_RULE_PATTERNS),
    readers: z.array(z.string().min(1).max(60)).min(1).max(MAX_RULE_READERS),
  }),
  response: S.AccessRule,
  errors: [
    'not_found',
    'forbidden',
    'invalid_request',
    'limit_reached',
    'moved',
  ],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      const r = yield* run((d) =>
        d.putAccessRule(
          ctx.params.owner,
          ctx.params.repo,
          ctx.params.rule,
          ctx.principal,
          ctx.body,
          ctx.dryRun,
        ),
      )
      return reply(r.rule, {
        status: r.created && !ctx.dryRun ? 201 : 200,
        headers: { 'cb-outcome': r.created ? 'created' : 'updated' },
      })
    }),
})

export const deleteAccessRule = defineOp({
  id: 'access_rules.delete',
  summary: 'Remove an access rule',
  description:
    'What it hid is visible again to everyone who can read the repository. Only an owner or admin.',
  tags: ['repos'],
  method: 'DELETE',
  path: '/repos/{owner}/{repo}/access-rules/{rule}',
  auth: 'required',
  scopes: ['repo:write'],
  pool: 'write',
  safety: 'destructive',
  idempotent: false,
  dryRun: true,
  params: ruleParams,
  response: z.null(),
  status: 204,
  errors: ['not_found', 'forbidden', 'moved'],
  handler: (ctx) =>
    Effect.gen(function* () {
      const { run } = yield* Domain
      yield* run((d) =>
        d.deleteAccessRule(
          ctx.params.owner,
          ctx.params.repo,
          ctx.params.rule,
          ctx.principal,
          ctx.dryRun,
        ),
      )
      return reply(null, { status: 204 })
    }),
})

export const accessOps = [listAccessRules, putAccessRule, deleteAccessRule]
