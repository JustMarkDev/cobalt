import { createGithub } from './github'
import type { Github } from './github'

/**
 * A GitHub that answers from a script: for the sample API, the documentation's
 * examples and tests. The running product talks to github.com.
 */
export function sampleGithub(o: { now?: () => number } = {}): Github {
  const json = (v: unknown) => Promise.resolve(Response.json(v))
  const fetch = (url: string) => {
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
    if (path.startsWith('/user/installations/1/repositories'))
      return json({
        repositories: [
          {
            id: 101,
            full_name: 'dana-okafor/dotfiles',
            private: false,
            default_branch: 'main',
            size: 412,
            permissions: { push: true },
          },
          {
            id: 102,
            full_name: 'dana-okafor/notes',
            private: true,
            default_branch: 'main',
            size: 96,
            permissions: { admin: true },
          },
        ],
      })
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
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
