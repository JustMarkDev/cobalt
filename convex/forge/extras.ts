import { v } from 'convex/values'
import { query } from '../_generated/server'
import { mutation } from '../lib/functions'
import { actorOf, system } from '../lib/actor'
import { inSecretsTeam, repoByKey, resolve } from '../lib/access'
import { fail, out } from '../lib/errors'

async function docOf(ctx: Parameters<typeof repoByKey>[0], full: string) {
  const repo = await repoByKey(ctx, full)
  if (!repo) return { repo: null, doc: null }
  const doc = await ctx.db
    .query('repoExtras')
    .withIndex('by_repoId', (q) => q.eq('repoId', repo._id))
    .unique()
  return { repo, doc }
}

export const secretsAccess = query({
  args: { owner: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, a) => {
    const p = await actorOf(ctx)
    const repo = await resolve(ctx, a.owner, a.name, p, 'read')
    return out({
      full: `${repo.owner}/${repo.name}`,
      repoId: repo.publicId,
      team: await inSecretsTeam(ctx, repo, p),
    })
  },
})

export const get = query({
  args: { full: v.string() },
  returns: v.string(),
  handler: async (ctx, { full }) => {
    await system(ctx)
    const { doc } = await docOf(ctx, full)
    return out({ version: doc?.version ?? 0, json: doc?.json ?? null })
  },
})

export const put = mutation({
  args: {
    full: v.string(),
    version: v.number(),
    json: v.string(),
    base: v.optional(v.string()),
    added: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const { repo, doc } = await docOf(ctx, a.full)
    if (!repo) fail('not_found', `No repository ${a.full}.`)
    let json = a.json
    if ((doc?.version ?? 0) !== a.version) {
      const merge =
        doc && a.base !== undefined && a.added !== undefined
          ? mergeAudit(doc.json, a.json, a.base, a.added)
          : null
      if (merge === null)
        fail(
          'version_mismatch',
          'Someone changed this at the same time. Try again.',
        )
      json = merge
    }
    if (doc)
      await ctx.db.patch('repoExtras', doc._id, {
        json,
        version: doc.version + 1,
      })
    else
      await ctx.db.insert('repoExtras', {
        repoId: repo._id,
        json,
        version: 1,
      })
    return out(null)
  },
})

function mergeAudit(
  stored: string,
  mine: string,
  base: string,
  added: string,
): string | null {
  const now = JSON.parse(stored) as Record<string, unknown>
  const { audit, ...rest } = now
  const next = JSON.parse(mine) as Record<string, unknown>
  const { audit: _mine, ...myRest } = next
  const entries = [
    ...(JSON.parse(added) as Array<unknown>),
    ...((audit as Array<unknown> | undefined) ?? []),
  ].slice(0, 1000)
  if (JSON.stringify(myRest) === base)
    return JSON.stringify({ ...now, audit: entries })
  if (JSON.stringify(rest) !== base) return null
  return JSON.stringify({ ...next, audit: entries })
}

export const mirrors = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await system(ctx)
    const found = []
    for (const d of await ctx.db.query('repoExtras').take(5000)) {
      const repo = await ctx.db.get('repos', d.repoId)
      if (!repo) continue
      for (const mirror of (JSON.parse(d.json) as { mirrors: Array<unknown> })
        .mirrors)
        found.push({ repo: `${repo.owner}/${repo.name}`, mirror })
    }
    return out(found)
  },
})
