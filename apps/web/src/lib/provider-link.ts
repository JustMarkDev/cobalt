import type { useWrite } from '~/lib/forge'

export type OAuthProvider = 'gitlab' | 'codeberg'

export const providerCallbackUrl = (p: OAuthProvider) =>
  `${window.location.origin}/${p}/callback`

export async function startProviderLink(
  write: ReturnType<typeof useWrite>,
  provider: OAuthProvider,
  returnTo: string,
): Promise<string | null> {
  const r = await write('providers.oauth.start', {
    provider,
    body: { redirect_uri: providerCallbackUrl(provider), return_to: returnTo },
  })
  if (r.error) return r.error.message
  window.location.assign(r.data.url)
  return null
}
