import type { useWrite } from '~/lib/forge'

export const githubCallbackUrl = () =>
  `${window.location.origin}/github/callback`

/**
 * Sends the person to GitHub, then back to /github/callback, where they choose
 * what to bring. `returnTo` is where they go after.
 *
 * By default this signs in, which returns at once when the app is already
 * authorized. With `install`, it opens the app's installation instead, where
 * they give it all their repositories or only some; GitHub signs them in on
 * the way back. An installation that is saved unchanged does not come back,
 * so signing in goes first and the callback sends them to install only when
 * the app sees nothing yet.
 */
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

/**
 * Callback addresses a sign-in may have started from other than this site.
 * GitHub sends an installation back to the app's first callback address, so
 * a sign-in started on a developer's machine lands here and goes back there.
 */
const DEV_CALLBACKS = new Set([
  'http://localhost:3000/github/callback',
  'http://127.0.0.1:3000/github/callback',
])

/** Where this callback should be handled, when it is not this page. */
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
