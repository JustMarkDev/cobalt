import {
  branchHidden,
  changeVisible,
  hiddenRules,
  pathHidden,
  rulesOverChange,
} from '@cobaltforge/api/access-rules'
import type { AccessRule, RuleViewer } from '@cobaltforge/api/access-rules'
import { touchedFiles } from '@cobaltforge/api/paths'
import { accountByHandle, roleIn } from './access'
import { fail } from './errors'
import type { Actor } from './actor'
import type { ChangeRec } from './changeTypes'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

export async function loadRules(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
): Promise<Array<AccessRule>> {
  return (
    await ctx.db
      .query('repoAccessRules')
      .withIndex('by_repoId_and_ruleId', (q) => q.eq('repoId', repo._id))
      .take(100)
  ).map((r) => ({
    id: r.ruleId,
    kind: r.kind,
    patterns: r.patterns,
    readers: r.readers,
    createdBy: r.createdBy,
    created: r.created,
  }))
}

export async function ruleViewer(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  a: Actor | null,
): Promise<RuleViewer | null> {
  if (!a) return null
  if (a.system) return { handle: '~system', teams: new Set(), all: true }
  if (a.runnerId && repo.owner.toLowerCase() === a.actingAs.toLowerCase())
    return { handle: a.handle, teams: new Set(), all: true }
  let all = repo.owner === a.handle
  const teams = new Set<string>()
  const owner = await accountByHandle(ctx, repo.owner)
  if (owner?.kind === 'organization') {
    const role = await roleIn(ctx, owner, a.handle)
    all = role === 'owner' || role === 'admin'
    for (const m of await ctx.db
      .query('teamMembers')
      .withIndex('by_handle', (q) => q.eq('handle', a.handle))
      .take(500)) {
      const t = await ctx.db.get('teams', m.teamId)
      if (t && t.org === repo.owner) teams.add(t.slug)
    }
  }
  return { handle: a.handle, teams, all }
}

export async function hiddenFor(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  a: Actor | null,
) {
  const rules = await loadRules(ctx, repo)
  return rules.length ? hiddenRules(rules, await ruleViewer(ctx, repo, a)) : []
}

export async function seesChange(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  c: ChangeRec,
  a: Actor | null,
  rules?: Array<AccessRule>,
) {
  const all = rules ?? (await loadRules(ctx, repo))
  if (!all.length) return true
  const head = c.patchSets.at(-1)
  const over = rulesOverChange(all, {
    branch: c.branch,
    files: head ? touchedFiles(head) : [],
  })
  return (
    !over.length || changeVisible(all, over, await ruleViewer(ctx, repo, a))
  )
}

export async function assertMayTouch(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  a: Actor,
  branch: string,
  files: Iterable<string>,
) {
  const hidden = await hiddenFor(ctx, repo, a)
  if (!hidden.length) return
  if (branchHidden(hidden, branch))
    fail(
      'forbidden',
      `${branch} is a private branch of ${repo.owner}/${repo.name}.`,
      { hint: 'Its access rule names who may work on it. Ask an admin.' },
    )
  const hit = [...files].filter((f) => pathHidden(hidden, f))
  if (hit.length)
    fail(
      'forbidden',
      `${hit.slice(0, 3).join(', ')} ${hit.length === 1 ? 'is' : 'are'} private in ${repo.owner}/${repo.name}.`,
      { hint: 'Its access rule names who may change it. Ask an admin.' },
    )
}

export async function hiddenChangeNumbers(
  ctx: QueryCtx,
  repo: Doc<'repos'>,
  a: Actor | null,
): Promise<Set<number>> {
  const out = new Set<number>()
  const rules = await loadRules(ctx, repo)
  if (!rules.length) return out
  const v = await ruleViewer(ctx, repo, a)
  const hidden = hiddenRules(rules, v)
  if (!hidden.length) return out
  const needFiles = hidden.some((r) => r.kind === 'path')
  for await (const c of ctx.db
    .query('changes')
    .withIndex('by_repoId_and_number', (q) => q.eq('repoId', repo._id))) {
    let files: Array<string> = []
    if (needFiles) {
      const head = await ctx.db
        .query('changeParts')
        .withIndex('by_changeId_and_kind_and_seq', (q) =>
          q.eq('changeId', c._id).eq('kind', 'patchSet'),
        )
        .order('desc')
        .first()
      if (head)
        files = [
          ...touchedFiles(
            JSON.parse(head.json) as {
              files: Record<string, unknown>
              contents?: Record<string, unknown>
            },
          ),
        ]
    }
    const over = rulesOverChange(rules, { branch: c.branch, files })
    if (over.length && !changeVisible(rules, over, v)) out.add(c.number)
  }
  return out
}
