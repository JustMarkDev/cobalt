import type { useWrite } from '~/lib/forge'

export const githubCallbackUrl = () =>
  `${window.location.origin}/github/callback`

export async function startGithubLink(
  write: ReturnType<typeof useWrite>,
  returnTo: string,
  o: { install?: boolean } = {},
): Promise<string | null> {
  const r = await write('github.oauth.start', {
    body: { redirect_uri: githubCallbackUrl(), return_to: returnTo },
  })
  if (r.error) return r.error.message
  window.location.assign(
    o.install && r.data.install_url ? r.data.install_url : r.data.url,
  )
  return null
}

const DEV_CALLBACKS = new Set([
  'http://localhost:3000/github/callback',
  'http://127.0.0.1:3000/github/callback',
])

export function callbackElsewhere(state: string | undefined): string | null {
  if (!state) return null
  try {
    const body = state.split('.')[0]
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
    const r = (JSON.parse(json) as { r?: unknown }).r
    if (typeof r !== 'string' || r === githubCallbackUrl()) return null
    return DEV_CALLBACKS.has(r) ? r : null
  } catch {
    return null
  }
}
