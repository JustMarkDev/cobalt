import { v } from 'convex/values'
import { query } from '../_generated/server'
import { system } from '../lib/actor'
import { out } from '../lib/errors'
import { repoUrl } from '../lib/present'
import {
  changeSearchDoc,
  issueSearchDoc,
  repoSearchDoc,
} from '@cobaltforge/api/search'

export const docs = query({
  args: { after: v.union(v.null(), v.string()), repos: v.number() },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const page = await ctx.db
      .query('repos')
      .withIndex('by_publicId', (q) =>
        a.after ? q.gt('publicId', a.after) : q,
      )
      .take(a.repos)
    const found = []
    for (const r of page) {
      const full = `${r.owner}/${r.name}`
      const url = repoUrl(r)
      found.push(repoSearchDoc({ ...r, id: r.publicId }, url))
      for await (const c of ctx.db
        .query('changes')
        .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id)))
        found.push(changeSearchDoc(full, url, { ...c, id: c.publicId }))
      for await (const i of ctx.db
        .query('issues')
        .withIndex('by_repoId_and_number', (q) => q.eq('repoId', r._id)))
        found.push(issueSearchDoc(full, url, { ...i, id: i.publicId }))
    }
    return out({
      docs: found,
      next: page.length === a.repos ? page.at(-1)!.publicId : null,
    })
  },
})
