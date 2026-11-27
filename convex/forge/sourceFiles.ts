// The files that configure a repository (.source/policy/main.yml and
// .source/triggers/*.yml) as the default branch has them, read from git by
// the API after a push. A change landed here applies them as it lands; this
// covers what reaches the branch any other way, such as git push.
import { v } from 'convex/values'
import { mutation } from '../lib/functions'
import { system } from '../lib/actor'
import { out } from '../lib/errors'
import { actorFor } from '../lib/events'
import { readPolicySource } from '../lib/policyFile'
import { readTriggerSource } from '../lib/triggerFile'

export const fromGit = mutation({
  args: {
    storeId: v.string(),
    ref: v.string(),
    sha: v.string(),
    by: v.optional(v.string()),
    policy: v.union(v.string(), v.null()),
    triggers: v.array(v.object({ path: v.string(), text: v.string() })),
  },
  returns: v.string(),
  handler: async (ctx, a) => {
    await system(ctx)
    const repo = await ctx.db
      .query('repos')
      .withIndex('by_storeId', (q) => q.eq('storeId', a.storeId))
      .unique()
    if (!repo || a.ref !== `refs/heads/${repo.defaultBranch}`) return out(null)
    const by = await actorFor(ctx, a.by ?? repo.owner)
    if (a.policy !== null)
      await readPolicySource(
        ctx,
        repo,
        { sha: a.sha, contents: { '.source/policy/main.yml': a.policy } },
        by,
      )
    await readTriggerSource(
      ctx,
      repo,
      {
        sha: a.sha,
        contents: Object.fromEntries(a.triggers.map((t) => [t.path, t.text])),
      },
      by,
      true,
    )
    return out(null)
  },
})
