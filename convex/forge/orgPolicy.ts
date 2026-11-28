import { v } from 'convex/values'
import { hasBusiness } from '@cobaltforge/api/plans'
import { describeCustomRule } from '@cobaltforge/api/policy-builtins'
import { internal } from '../_generated/api'
import { internalMutation, query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { bodyOf } from '../lib/input'
import { signedIn } from '../lib/actor'
import { accountByHandle, orgFor } from '../lib/access'
import { fail } from '../lib/errors'
import { actorFor, counters, emit } from '../lib/events'
import { audit } from '../lib/audit'
import { planOf } from '../lib/plan'
import { ORG_RULE, orgRules } from '../lib/orgPolicy'
import type { OrgRuleRec } from '../lib/orgPolicy'
import type { Actor } from '../lib/actor'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

const ruleView = v.object({
  id: v.string(),
  name: v.string(),
  kind: v.string(),
  when: v.string(),
  requires: v.array(v.string()),
  teams: v.array(v.string()),
  createdBy: v.string(),
  created: v.number(),
})

const present = (r: OrgRuleRec) => ({
  id: `${ORG_RULE}${r.id}`,
  name: r.name,
  kind: r.kind,
  ...describeCustomRule(r),
  teams: r.teams,
  createdBy: r.createdBy,
  created: r.created,
})

// Members see what their organization requires; owners and admins on
// Business change it.
export const get = query({
  args: { org: v.string() },
  returns: v.object({
    business: v.boolean(),
    canEdit: v.boolean(),
    rules: v.array(ruleView),
  }),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const { acct, role } = await orgFor(ctx, a.org, p, 'member')
    return {
      business: hasBusiness((await planOf(ctx, acct._id)).plan),
      canEdit: role === 'owner' || role === 'admin',
      rules: (await orgRules(ctx, acct._id)).map(present),
    }
  },
})

async function editable(ctx: MutationCtx, org: string, p: Actor) {
  const { acct } = await orgFor(ctx, org, p, 'admin')
  if (!hasBusiness((await planOf(ctx, acct._id)).plan))
    fail(
      'plan_required',
      `${org} is not on Business, which sets policies for every repository.`,
      { hint: 'Move the organization to Business. See /pricing.' },
    )
  return { p, acct }
}

async function save(
  ctx: MutationCtx,
  acct: Doc<'accounts'>,
  rules: Array<OrgRuleRec>,
  by: string,
) {
  const doc = await ctx.db
    .query('orgPolicies')
    .withIndex('by_organizationId', (q) => q.eq('organizationId', acct._id))
    .unique()
  const fields = { rules: JSON.stringify(rules), updated: Date.now() }
  if (doc) await ctx.db.patch('orgPolicies', doc._id, fields)
  else
    await ctx.db.insert('orgPolicies', { organizationId: acct._id, ...fields })
  await ctx.scheduler.runAfter(0, internal.forge.orgPolicy.touchRepos, {
    organizationId: acct._id,
    after: null,
    by,
  })
}

export const setRule = mutation({
  args: {
    org: v.string(),
    id: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal('required_check'),
      v.literal('path_approval'),
      v.literal('max_lines'),
      v.literal('allowed_paths'),
    ),
    check: v.optional(v.string()),
    paths: v.optional(v.array(v.string())),
    approvals: v.optional(v.number()),
    from: v.optional(v.array(v.string())),
    max_lines: v.optional(v.number()),
    teams: v.optional(v.array(v.string())),
  },
  returns: ruleView,
  handler: async (ctx, a) => {
    const checked = await bodyOf(ctx, 'policy.create_rule', {
      id: a.id,
      name: a.name,
      kind: a.kind,
      check: a.check,
      paths: a.paths,
      approvals: a.approvals,
      from: a.from,
      max_lines: a.max_lines,
    })
    const { p, acct } = await editable(ctx, a.org, await signedIn(ctx))
    const bad = (pointer: string, message: string) =>
      fail('invalid_request', message, {
        errors: [{ pointer, code: 'invalid', message }],
      })
    const need = {
      required_check: ['check'],
      path_approval: ['paths'],
      max_lines: ['max_lines'],
      allowed_paths: ['paths'],
    } as const
    for (const k of need[a.kind])
      if (a[k] === undefined) bad(`/body/${k}`, `A ${a.kind} rule needs ${k}.`)
    for (const h of a.from ?? [])
      if ((await accountByHandle(ctx, h))?.kind !== 'person')
        bad('/body/from', `${h} is not a person.`)
    const teams = [...new Set(a.teams ?? [])]
    for (const slug of teams)
      if (
        !(await ctx.db
          .query('teams')
          .withIndex('by_org_and_slug', (q) =>
            q.eq('org', acct.handle).eq('slug', slug),
          )
          .unique())
      )
        bad('/body/teams', `${a.org} has no team ${slug}.`)
    const rules = await orgRules(ctx, acct._id)
    const have = rules.find((r) => r.id === a.id)
    const rec: OrgRuleRec = {
      id: a.id,
      name: checked.name,
      kind: a.kind,
      ...(a.kind === 'required_check' ? { check: a.check } : {}),
      ...(a.kind === 'path_approval'
        ? { paths: a.paths, approvals: a.approvals ?? 1, from: a.from ?? [] }
        : {}),
      ...(a.kind === 'max_lines' ? { maxLines: a.max_lines } : {}),
      ...(a.kind === 'allowed_paths' ? { paths: a.paths } : {}),
      teams,
      createdBy: have?.createdBy ?? p.handle,
      created: have?.created ?? Date.now(),
    }
    await save(
      ctx,
      acct,
      [...rules.filter((r) => r.id !== a.id), rec],
      p.handle,
    )
    await audit(ctx, acct, p, 'policy.rule_set', `${ORG_RULE}${a.id}`, {
      kind: a.kind,
      ...(teams.length ? { teams } : {}),
      created: !have,
    })
    return present(rec)
  },
})

export const removeRule = mutation({
  args: { org: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { p, acct } = await editable(ctx, a.org, await signedIn(ctx))
    const id = a.id.startsWith(ORG_RULE) ? a.id.slice(ORG_RULE.length) : a.id
    const rules = await orgRules(ctx, acct._id)
    if (!rules.some((r) => r.id === id))
      fail('not_found', `${a.org} has no rule ${a.id}.`)
    await save(
      ctx,
      acct,
      rules.filter((r) => r.id !== id),
      p.handle,
    )
    await audit(ctx, acct, p, 'policy.rule_removed', `${ORG_RULE}${id}`)
    return null
  },
})

const BATCH = 20

// Every change of the organization's repositories is judged again: bump what
// their versions are made of, a few repositories per run, in name order.
export const touchRepos = internalMutation({
  args: {
    organizationId: v.id('accounts'),
    after: v.union(v.string(), v.null()),
    by: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const after = a.after
    const repos = await ctx.db
      .query('repos')
      .withIndex('by_ownerId_and_name', (q) =>
        after === null
          ? q.eq('ownerId', a.organizationId)
          : q.eq('ownerId', a.organizationId).gt('name', after),
      )
      .take(BATCH)
    for (const repo of repos) await touch(ctx, repo, a.by)
    if (repos.length === BATCH)
      await ctx.scheduler.runAfter(0, internal.forge.orgPolicy.touchRepos, {
        ...a,
        after: repos[repos.length - 1].name,
      })
    return null
  },
})

async function touch(ctx: MutationCtx, repo: Doc<'repos'>, by: string) {
  for (const c of await ctx.db
    .query('changes')
    .withIndex('by_repoId_and_number', (q) => q.eq('repoId', repo._id))
    .take(1000))
    await ctx.db.patch('changes', c._id, { version: c.version + 1 })
  const c = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', c._id, {
    policyRev: c.policyRev + 1,
    changeRev: c.changeRev + 1,
  })
  await emit(
    ctx,
    repo,
    'repo.policy_changed',
    await actorFor(ctx, by),
    { object: 'repo', id: repo.publicId, number: null },
    ['organization'],
    null,
  )
}
