/**
 * Sign-in on the server. `handler` forwards `/api/auth/*` to Convex, where
 * Better Auth runs. `currentUser` is who a request is from, read from its
 * session cookie: use it in server functions and loaders, never trust a
 * handle the browser sends.
 */
import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'
import { api } from '../../../../../convex/_generated/api'

// Vite puts `.env.local` in `import.meta.env`; a host sets real environment
// variables, which win.
const fromVite: Record<string, string | undefined> = import.meta.env
const setting = (name: string) => process.env[name] ?? fromVite[name] ?? ''

// Built on first use. The library refuses to start without its addresses,
// and a missing setting should fail the sign-in request that needs it, with
// its message, not every page that imports this file.
let made: ReturnType<typeof convexBetterAuthReactStart> | undefined
const auth = () =>
  (made ??= convexBetterAuthReactStart({
    convexUrl: setting('VITE_CONVEX_URL'),
    convexSiteUrl: setting('VITE_CONVEX_SITE_URL'),
    // The browser keeps the Convex token Better Auth gives it in a cookie, and
    // the server render uses that token rather than asking Convex for one on
    // every page (one round trip, often two). It is the token the browser's
    // own Convex client signs in with, so it can do nothing more. One within
    // 30 seconds of expiring is fetched afresh: the library's default would
    // keep using it for a minute after it expired, and Convex refuses those.
    // Like the browser's copy, a token stays good until it expires (15
    // minutes), so signing out elsewhere reaches the server render no later.
    jwtCache: {
      enabled: true,
      expirationToleranceSeconds: -30,
      // The library asks for a fresh token and tries once more only when this
      // answers false. Always do: a cached token Convex refuses (its keys
      // changed, say) then costs one round trip instead of failing the page.
      // Only reads go through it (`fetchAuthQuery`). Do not send writes
      // (`fetchAuthMutation`) this way: a write whose answer was lost would
      // run twice.
      isAuthError: () => false,
    },
  }))

/** Forwards a `/api/auth/*` request to Convex. */
export const handler = (request: Request) => auth().handler(request)

export type CurrentUser = {
  id: string
  name: string
  email: string
  handle: string
}

/**
 * Whether the request carries a session cookie at all. Asking Convex for a
 * token is a round trip on every server render; a visitor who never signed
 * in has no cookie, and the answer for them is always "nobody".
 */
async function hasSession() {
  const { getRequestHeaders } = await import('@tanstack/react-start/server')
  return hasSessionCookie(new Headers(getRequestHeaders()).get('cookie'))
}

/**
 * Better Auth's session cookie, by the names it gives it: `better-auth`, then
 * `.` or `-`, then `session_token`, with `__Secure-` in front over HTTPS.
 * Checked here rather than with `better-auth/cookies`, which brings the
 * library's JWT and session-store code into the server for one string test.
 */
export function hasSessionCookie(cookie: string | null) {
  return (
    cookie !== null &&
    /(?:^|;\s*)(?:__Secure-)?better-auth[.-]session_token=[^;\s]/.test(cookie)
  )
}

/** The signed-in person behind the current request, or null. */
export async function currentUser(): Promise<CurrentUser | null> {
  if (!(await hasSession()) || !(await auth().getToken())) return null
  const user = await auth().fetchAuthQuery(api.auth.getCurrentUser, {})
  return user?.handle ? { ...user, handle: user.handle } : null
}

/** The Convex token for the current request's session, for the server render. */
export const convexTokenNow = async () =>
  (await hasSession()) ? ((await auth().getToken()) ?? null) : null
