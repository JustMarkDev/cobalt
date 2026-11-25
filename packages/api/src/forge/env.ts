// The provider links of the running app, from its environment:
//
//   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET
//       the Cobalt GitHub App (Code Storage holds its key too)
//   GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET      an OAuth app on gitlab.com
//   CODEBERG_CLIENT_ID, CODEBERG_CLIENT_SECRET  an OAuth app on codeberg.org
//   CB_TOKEN_KEYS     keys that seal provider tokens at rest (see vault.ts)
//   CB_HOOK_SECRET    master secret per-repository webhook secrets derive from
import { ConvexProviderStore } from './convex-store'
import { createGithubForge, githubAppFromEnv } from './github'
import { createGitlab } from './gitlab'
import { createForgejo } from './forgejo'
import { ProviderSync } from './sync'
import { TokenVault } from './vault'
import type { GitStores } from '@cobaltforge/git/stores'
import type { ConvexCall } from '../domain/convex'
import type { Github } from '../github'
import type { ForgeProvider, ProviderId, ProviderOAuth } from './types'

export function providersFromEnv(
  env: Record<string, string | undefined>,
  o: {
    call: ConvexCall
    github: Github | null
    git: GitStores | undefined
    hookBase: string
    stateKey: string | null
    now: () => number
  },
): ProviderSync {
  const forges: Partial<Record<ProviderId, ForgeProvider>> = {}
  const oauth: Partial<Record<ProviderId, ProviderOAuth>> = {}
  const app = githubAppFromEnv(env)
  if (app && o.github) forges.github = createGithubForge({ app, now: o.now })
  if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) {
    const g = createGitlab({
      clientId: env.GITLAB_CLIENT_ID,
      clientSecret: env.GITLAB_CLIENT_SECRET,
      now: o.now,
    })
    forges.gitlab = g.forge
    oauth.gitlab = g.oauth
  }
  if (env.CODEBERG_CLIENT_ID && env.CODEBERG_CLIENT_SECRET) {
    const c = createForgejo({
      id: 'codeberg',
      host: 'codeberg.org',
      clientId: env.CODEBERG_CLIENT_ID,
      clientSecret: env.CODEBERG_CLIENT_SECRET,
      now: o.now,
    })
    forges.codeberg = c.forge
    oauth.codeberg = c.oauth
  }
  const github = o.github
  return new ProviderSync({
    store: new ConvexProviderStore(o.call),
    forges,
    oauth,
    vault: TokenVault.fromEnv(env.CB_TOKEN_KEYS).catch((e: unknown) => {
      console.error('[providers] CB_TOKEN_KEYS is not usable:', String(e))
      return null
    }),
    git: o.git,
    hookSecret: env.CB_HOOK_SECRET ?? null,
    githubHookSecret: app?.webhookSecret ?? null,
    hookBase: o.hookBase,
    stateKey: o.stateKey,
    ...(github
      ? {
          githubToken: (access: string, handle: string) =>
            github.token(access, handle),
          githubAuthorize: async (
            access: string,
            handle: string,
            slug: string,
          ) => {
            const r = await github.authorize(access, handle, slug)
            return {
              id: r.id,
              installation: r.installation,
              defaultBranch: r.defaultBranch,
            }
          },
        }
      : {}),
    now: o.now,
    log: (line) => console.log('[providers]', JSON.stringify(line)),
  })
}
