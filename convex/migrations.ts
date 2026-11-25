// Data migrations, run once per deployment:
//
//   npx convex run migrations:run '{"fn": "migrations:githubLinksToRemoteRepos"}'
//
// The component remembers where each one got to, so running it again resumes
// or does nothing.
import { Migrations } from '@convex-dev/migrations'
import { components, internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import type { DataModel } from './_generated/dataModel'

export const migrations = new Migrations<DataModel>(components.migrations, {
  internalMutation,
})

export const run = migrations.runner()

/**
 * `githubLinks` held which GitHub repository feeds which repository here.
 * `remoteRepos` holds the same for every provider, with more. Each link
 * becomes a linked repository; the mirror and the upstream of the repository
 * are unchanged. After it has run everywhere, a later deploy drops the table.
 */
export const githubLinksToRemoteRepos = migrations.define({
  table: 'githubLinks',
  migrateOne: async (ctx, l) => {
    const had = await ctx.db
      .query('remoteRepos')
      .withIndex('by_provider_and_instance_and_externalId', (q) =>
        q
          .eq('provider', 'github')
          .eq('instance', 'github.com')
          .eq('externalId', String(l.githubId)),
      )
      .unique()
    if (had) return
    const repo = await ctx.db.get('repos', l.repoId)
    if (!repo) return
    await ctx.db.insert('remoteRepos', {
      provider: 'github',
      instance: 'github.com',
      externalId: String(l.githubId),
      fullName: l.slug,
      repoId: l.repoId,
      connectionId: null,
      by: l.by,
      state: 'linked',
      problem: null,
      installation: null,
      webhookId: null,
      credentialId: null,
      lfs: false,
      meta: {
        private: repo.visibility === 'private',
        archived: false,
        defaultBranch: repo.defaultBranch,
        description: repo.description,
        stars: repo.stars,
        forks: repo.forks,
        license: repo.license,
        website: repo.website,
      },
      lastPull: 0,
      lastSync: null,
      at: l.at,
    })
  },
})

export const all = migrations.runner([
  internal.migrations.githubLinksToRemoteRepos,
])
