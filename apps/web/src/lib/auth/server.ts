import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'
import { api } from '../../../../../convex/_generated/api'

const fromVite: Record<string, string | undefined> = import.meta.env
const setting = (name: string) => process.env[name] ?? fromVite[name] ?? ''

let made: ReturnType<typeof convexBetterAuthReactStart> | undefined
const auth = () =>
  (made ??= convexBetterAuthReactStart({
    convexUrl: setting('VITE_CONVEX_URL'),
    convexSiteUrl: setting('VITE_CONVEX_SITE_URL'),
    jwtCache: {
      enabled: true,
      expirationToleranceSeconds: -30,
      isAuthError: () => false,
    },
  }))

export const handler = (request: Request) =>
  auth().handler(withoutCloudflareHeaders(request))

// The site is served through Cloudflare, and so is convex.site. A request
// that reaches Cloudflare still carrying the `cf-*` headers it added on the way
// in (cf-connecting-ip above all) is refused with "error code: 1000", so the
// auth proxy must not pass them on.
export function withoutCloudflareHeaders(request: Request): Request {
  const headers = new Headers(request.headers)
  const names = [...headers.keys()].filter(
    (name) => name.startsWith('cf-') || name === 'cdn-loop',
  )
  if (!names.length) return request
  for (const name of names) headers.delete(name)
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error duplex is needed to stream a request body
    duplex: 'half',
  })
}

export type CurrentUser = {
  id: string
  name: string
  email: string
  handle: string
}

async function hasSession() {
  const { getRequestHeaders } = await import('@tanstack/react-start/server')
  return hasSessionCookie(new Headers(getRequestHeaders()).get('cookie'))
}

export function hasSessionCookie(cookie: string | null) {
  return (
    cookie !== null &&
    /(?:^|;\s*)(?:__Secure-)?better-auth[.-]session_token=[^;\s]/.test(cookie)
  )
}

export async function currentUser(): Promise<CurrentUser | null> {
  if (!(await hasSession()) || !(await auth().getToken())) return null
  const user = await auth().fetchAuthQuery(api.auth.getCurrentUser, {})
  return user?.handle ? { ...user, handle: user.handle } : null
}

export const convexTokenNow = async () =>
  (await hasSession()) ? ((await auth().getToken()) ?? null) : null
