import { createGithub } from './github'
import { createGithubForge } from './forge/github'
import type { Github } from './github'
import type { GithubForge } from './forge/github'

const sampleRepos = [
  {
    id: 101,
    full_name: 'dana-okafor/dotfiles',
    private: false,
    default_branch: 'main',
    size: 412,
    description: 'My shell, editor and git setup.',
    stargazers_count: 12,
    forks_count: 2,
    homepage: null,
    license: { spdx_id: 'MIT' },
    permissions: { push: true },
  },
  {
    id: 102,
    full_name: 'dana-okafor/notes',
    private: true,
    default_branch: 'main',
    size: 96,
    description: '',
    stargazers_count: 0,
    forks_count: 0,
    homepage: null,
    license: null,
    permissions: { admin: true },
  },
]

/** The fetch behind the sample GitHub: github.com and api.github.com, scripted. */
export function sampleGithubFetch(url: string): Promise<Response> {
  const json = (v: unknown) => Promise.resolve(Response.json(v))
  if (url === 'https://github.com/login/device/code')
    return json({
      device_code: 'dev_sample',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    })
  if (url === 'https://github.com/login/oauth/access_token')
    return json({ access_token: 'gho_sample' })
  const path = url.replace('https://api.github.com', '')
  if (path === '/user') return json({ login: 'dana-okafor' })
  if (path.startsWith('/user/installations?'))
    return json({ installations: [{ id: 1 }] })
  if (
    path.startsWith('/user/installations/1/repositories') ||
    path.startsWith('/installation/repositories')
  )
    return json({ total_count: sampleRepos.length, repositories: sampleRepos })
  for (const r of sampleRepos) {
    if (path === `/repos/${r.full_name}`) return json(r)
    if (path === `/repos/${r.full_name}/languages`)
      return json({ Shell: 9000, Lua: 1200 })
    if (path === `/repos/${r.full_name}/installation`) return json({ id: 1 })
    for (const list of ['pulls', 'issues', 'releases'])
      if (path.startsWith(`/repos/${r.full_name}/${list}?`)) return json([])
  }
  return Promise.resolve(new Response('not found', { status: 404 }))
}

/** The GitHub adapter of the sample, reaching the scripted repositories as installation 1. */
export function sampleGithubForge(): GithubForge {
  return createGithubForge({
    fetch: (u) => sampleGithubFetch(u),
    installationToken: () => Promise.resolve('ghs_sample'),
  })
}

/**
 * A GitHub that answers from a script: for the sample API, the documentation's
 * examples and tests. The running product talks to github.com.
 */
export function sampleGithub(o: { now?: () => number } = {}): Github {
  const fetch = (url: string) => sampleGithubFetch(url)
  return createGithub(
    {
      clientId: 'Iv1.sample',
      clientSecret: 'sample-client-secret',
      sealKey: 'sample-github-seal-key',
      slug: 'cobalt-forge-sync',
    },
    { fetch, ...o, nonce: () => new Uint8Array(12) },
  )
}
