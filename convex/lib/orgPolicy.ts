import { hasBusiness } from '@cobaltforge/api/plans'
import { planOf } from './plan'
import type { CustomRuleRec } from './changeTypes'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

// A rule an organization sets for its repositories. `teams` narrows it to the
// repositories those teams are given; empty means every repository.
export type OrgRuleRec = CustomRuleRec & { teams: Array<string> }

// Every rule an organization sets is shown and evaluated with this prefix, so
// a repository can tell it apart and cannot name one of its own the same way.
export const ORG_RULE = 'org.'

export const isOrgRule = (id: string) => id.startsWith(ORG_RULE)

export async function orgRules(
  ctx: Pick<QueryCtx, 'db'>,
  organizationId: Id<'accounts'>,
): Promise<Array<OrgRuleRec>> {
  const doc = await ctx.db
    .query('orgPolicies')
    .withIndex('by_organizationId', (q) =>
      q.eq('organizationId', organizationId),
    )
    .unique()
  return doc ? (JSON.parse(doc.rules) as Array<OrgRuleRec>) : []
}

// The organization's rules that bind one repository, as repository rules. An
// organization off Business keeps its rules but they stop applying.
export async function orgRulesFor(
  ctx: Pick<QueryCtx, 'db'>,
  repo: Pick<Doc<'repos'>, '_id' | 'ownerId'>,
): Promise<Array<CustomRuleRec>> {
  const owner = await ctx.db.get('accounts', repo.ownerId)
  if (owner?.kind !== 'organization') return []
  const rules = await orgRules(ctx, owner._id)
  if (!rules.length) return []
  if (!hasBusiness((await planOf(ctx, owner._id)).plan)) return []
  let teams: Set<string> | null = null
  const out: Array<CustomRuleRec> = []
  for (const { teams: only, ...rule } of rules) {
    if (only.length) {
      teams ??= await teamsOf(ctx, repo._id)
      if (!only.some((t) => teams!.has(t))) continue
    }
    out.push({ ...rule, id: `${ORG_RULE}${rule.id}` })
  }
  return out
}

async function teamsOf(ctx: Pick<QueryCtx, 'db'>, repoId: Id<'repos'>) {
  const slugs = new Set<string>()
  for (const row of await ctx.db
    .query('teamRepos')
    .withIndex('by_repoId', (q) => q.eq('repoId', repoId))
    .take(200)) {
    const team = await ctx.db.get('teams', row.teamId)
    if (team) slugs.add(team.slug)
  }
  return slugs
}
