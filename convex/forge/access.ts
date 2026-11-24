import { v } from 'convex/values'
import {
  MAX_ACCESS_RULES,
  readsRule,
  ruleProblems,
} from '@cobaltforge/api/access-rules'
import type { AccessRule } from '@cobaltforge/api/access-rules'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { actorOf, signedIn } from '../lib/actor'
import {
  accountByHandle,
  assertAdmin,
  repoByPublicId,
  resolve,
} from '../lib/access'
import { bumpAccess } from '../lib/acl'
import {
  hiddenChangeNumbers,
  hiddenFor,
  loadRules,
  ruleViewer,
} from '../lib/accessRules'
import { fail, finish, out } from '../lib/errors'
import { counters } from '../lib/events'
import { repoUrl } from '../lib/present'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * Access rules: branches and paths only some people may see. Only the
 * repository's administrators write them; a reader sees the rules they read.
 */

function present(repo: Doc<'repos'>, r: AccessRule) {
  return {
    object: 'access_rule' as const,
    id: r.id,
    kind: r.kind,
    patterns: [...r.patterns],
    readers: [...r.readers],
    created_by: r.createdBy,
    created_at: new Date(r.created).toISOString(),
    url: `${repoUrl(repo)}/access-rules/${r.id}`,
  }
}

export const list = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p)
    const viewer = await ruleViewer(ctx, repo, p)
    return out(
      (await loadRules(ctx, repo))
        .filter((r) => readsRule(r, viewer))
        .map((r) => present(repo, r)),
    )
  },
})

/** Every change's representation and every cached answer move with who may see what. */
async function changed(ctx: MutationCtx, repo: Doc<'repos'>) {
  await bumpAccess(ctx)
  await ctx.db.patch('repos', repo._id, { aclRev: repo.aclRev + 1 })
  const c = await counters(ctx, repo)
  await ctx.db.patch('repoCounters', c._id, { changeRev: c.changeRev + 1 })
}

export const put = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    id: v.string(),
    kind: v.union(v.literal('branch'), v.literal('path')),
    patterns: v.array(v.string()),
    readers: v.array(v.string()),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await assertAdmin(ctx, repo, p)
    const problems = ruleProblems(a, repo.defaultBranch)
    for (const [i, r] of a.readers.entries())
      if (r.startsWith('team:')) {
        const t = await ctx.db
          .query('teams')
          .withIndex('by_org_and_slug', (q) =>
            q.eq('org', repo.owner).eq('slug', r.slice(5)),
          )
          .unique()
        if (!t)
          problems.push([
            `/body/readers/${i}`,
            `${repo.owner} has no team ${r.slice(5)}.`,
          ])
      } else if ((await accountByHandle(ctx, r))?.kind !== 'person')
        problems.push([`/body/readers/${i}`, `${r} is not a person.`])
    if (problems.length)
      fail('invalid_request', problems[0][1], {
        errors: problems.map(([pointer, message]) => ({
          pointer,
          code: 'invalid',
          message,
        })),
      })
    const rows = await ctx.db
      .query('repoAccessRules')
      .withIndex('by_repoId_and_ruleId', (q) => q.eq('repoId', repo._id))
      .take(MAX_ACCESS_RULES + 1)
    const had = rows.find((r) => r.ruleId === a.id)
    if (!had && rows.length >= MAX_ACCESS_RULES)
      fail(
        'limit_reached',
        `A repository has at most ${MAX_ACCESS_RULES} access rules.`,
      )
    const rule: AccessRule = {
      id: a.id,
      kind: a.kind,
      patterns: [...new Set(a.patterns)],
      readers: [...new Set(a.readers)],
      createdBy: had?.createdBy ?? p.handle,
      created: had?.created ?? Date.now(),
    }
    const fields = {
      kind: rule.kind,
      patterns: rule.patterns,
      readers: rule.readers,
      createdBy: rule.createdBy,
      created: rule.created,
    }
    if (had) await ctx.db.patch('repoAccessRules', had._id, fields)
    else
      await ctx.db.insert('repoAccessRules', {
        repoId: repo._id,
        ruleId: a.id,
        ...fields,
      })
    await changed(ctx, repo)
    return finish(a.dry, { rule: present(repo, rule), created: !had })
  },
})

export const remove = mutation({
  args: {
    owner: v.string(),
    name: v.string(),
    id: v.string(),
    dry: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await signedIn(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'write')
    await assertAdmin(ctx, repo, p)
    const row = await ctx.db
      .query('repoAccessRules')
      .withIndex('by_repoId_and_ruleId', (q) =>
        q.eq('repoId', repo._id).eq('ruleId', a.id),
      )
      .unique()
    if (!row) fail('not_found', `No access rule ${a.id}.`)
    await ctx.db.delete('repoAccessRules', row._id)
    await changed(ctx, repo)
    return finish(a.dry, null)
  },
})

/** What the caller may not see in a repository's branches and files. */
export const view = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p)
    return out({
      hidden: (await hiddenFor(ctx, repo, p)).map((r) => ({
        id: r.id,
        kind: r.kind,
        patterns: [...r.patterns],
      })),
    })
  },
})

/** The numbers of a repository's changes the caller may not see, by repository id. */
export const hiddenChanges = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    const repo = await repoByPublicId(ctx, a.id)
    if (!repo) return out([])
    return out([...(await hiddenChangeNumbers(ctx, repo, p))])
  },
})
