import { FakeStores } from '@cobaltforge/git/fake'
import { sampleGithubForge } from '../github-sample'
import { createGitlab } from './gitlab'
import { MemoryProviderStore } from './store'
import { ProviderSync } from './sync'
import { TokenVault } from './vault'
import type { Github } from '../github'
import type { ForgeProvider, ProviderId, ProviderOAuth } from './types'

const T = '2026-11-03T10:00:00Z'
const person = (id: number, username: string, name: string) => ({
  id,
  username,
  name,
  avatar_url: `https://gitlab.com/uploads/-/system/user/avatar/${id}/avatar.png`,
})
const dana = person(4242, 'dana.okafor', 'Dana Okafor')
const tomas = person(5150, 'tomas.r', 'Tomás Rivera')

const zine = {
  id: 61_204_118,
  path_with_namespace: 'dana.okafor/zine',
  visibility: 'public',
  archived: false,
  default_branch: 'main',
  description: 'A small static site generator for zines.',
  star_count: 31,
  forks_count: 4,
  license: { key: 'mit' },
  statistics: { repository_size: 1_840_000 },
  web_url: 'https://gitlab.com/dana.okafor/zine',
  permissions: { project_access: { access_level: 40 }, group_access: null },
}

const merges = [
  {
    iid: 3,
    title: 'Add a dark print stylesheet',
    description: 'Prints on dark paper without wasting toner.',
    state: 'opened',
    draft: false,
    author: tomas,
    sha: '9f2c1e0b7a6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b',
    source_branch: 'dark-print',
    target_branch: 'main',
    source_project_id: 70_000_001,
    target_project_id: zine.id,
    created_at: '2026-11-01T09:12:00Z',
    updated_at: '2026-11-02T16:40:00Z',
    closed_at: null,
    merged_at: null,
    web_url: 'https://gitlab.com/dana.okafor/zine/-/merge_requests/3',
  },
  {
    iid: 2,
    title: 'Render footnotes',
    description: '',
    state: 'merged',
    author: dana,
    sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    source_branch: 'footnotes',
    target_branch: 'main',
    source_project_id: zine.id,
    target_project_id: zine.id,
    created_at: '2026-10-20T08:00:00Z',
    updated_at: '2026-10-21T11:00:00Z',
    closed_at: null,
    merged_at: '2026-10-21T11:00:00Z',
    web_url: 'https://gitlab.com/dana.okafor/zine/-/merge_requests/2',
  },
]

const issues = [
  {
    iid: 5,
    title: 'Images are blurry in print',
    description: 'At 300 dpi the cover image is upscaled.',
    state: 'opened',
    author: tomas,
    labels: ['bug', 'print'],
    created_at: '2026-10-30T14:00:00Z',
    updated_at: '2026-11-02T10:00:00Z',
    closed_at: null,
    web_url: 'https://gitlab.com/dana.okafor/zine/-/issues/5',
  },
]

const releases = [
  {
    tag_name: 'v0.3.0',
    name: 'Zine 0.3',
    description: 'Footnotes, and a faster build.',
    author: dana,
    created_at: '2026-10-22T09:00:00Z',
    released_at: '2026-10-22T09:00:00Z',
    _links: { self: 'https://gitlab.com/dana.okafor/zine/-/releases/v0.3.0' },
  },
]

const note = (id: number, body: string, author: typeof dana, at: string) => ({
  id,
  body,
  system: false,
  author,
  created_at: at,
  updated_at: at,
})

export function sampleGitlabFetch(now: () => number) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    const json = (v: unknown, status = 200) =>
      Promise.resolve(Response.json(v, { status }))
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname)
    const method = init?.method ?? 'GET'
    if (path === '/oauth/token')
      return json({
        access_token: `glsample-${now()}`,
        refresh_token: `glrefresh-${now()}`,
        expires_in: 7200,
        created_at: Math.floor(now() / 1000),
        scope: 'api',
      })
    if (path === '/oauth/revoke') return json({})
    const p = path.replace('/api/v4', '')
    const project = '/projects/dana.okafor/zine'
    if (p === '/user') return json(dana)
    if (p === '/projects') return json([zine])
    if (p === project) return json(zine)
    if (p === `${project}/languages`)
      return json({ TypeScript: 81.4, CSS: 18.6 })
    if (p === `${project}/hooks` && method === 'POST')
      return json({ id: 7001 }, 201)
    if (p.startsWith(`${project}/hooks/`)) return json({}, 204)
    if (p === `${project}/merge_requests`) return json(merges)
    if (p === `${project}/issues`) return json(issues)
    if (p === `${project}/releases`) return json(releases)
    if (p === `${project}/merge_requests/3/notes`)
      return json([
        note(901, 'Looks good on my printer.', dana, '2026-11-02T16:40:00Z'),
      ])
    if (p === `${project}/issues/5/notes`)
      return json([
        note(
          902,
          'Same here with the A5 layout.',
          dana,
          '2026-11-02T10:00:00Z',
        ),
      ])
    if (/\/(merge_requests|issues)\/\d+\/notes$/.test(p)) return json([])
    if (p === `${project}/merge_requests/3/changes`)
      return json({
        changes: [
          {
            old_path: 'styles/print.css',
            new_path: 'styles/print.css',
            new_file: false,
            deleted_file: false,
            diff: '@@ -1,3 +1,4 @@\n @media print {\n-  body { color: black; }\n+  body { color: #eee; background: #111; }\n+  img { filter: invert(1); }\n }\n',
          },
        ],
      })
    return json({ message: '404 Not Found' }, 404)
  }
}

export function sampleGitlab(now: () => number) {
  return createGitlab({
    clientId: 'sample-gitlab-client',
    clientSecret: 'sample-gitlab-secret',
    fetch: sampleGitlabFetch(now),
    now,
  })
}

export function sampleProviders(
  github: Github | null,
  html: string,
  now: () => number,
  more: {
    forges?: Partial<Record<ProviderId, ForgeProvider>>
    oauth?: Partial<Record<ProviderId, ProviderOAuth>>
  } = {},
) {
  const gitlab = sampleGitlab(now)
  void T
  return new ProviderSync({
    store: new MemoryProviderStore((full) => full),
    forges: {
      ...(github ? { github: sampleGithubForge() } : {}),
      gitlab: gitlab.forge,
      ...more.forges,
    },
    oauth: { gitlab: gitlab.oauth, ...more.oauth },
    vault: TokenVault.ephemeral(),
    git: new FakeStores(),
    hookSecret: 'sample-provider-hook-secret',
    githubHookSecret: 'sample-github-hook-secret',
    hookBase: `${html}/hooks`,
    stateKey: 'sample-provider-state-key',
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
    now,
  })
}
