import { createHash } from 'node:crypto'
import { handler } from '~/lib/auth/server'
import type { SessionResolver, SessionUser } from '@cobaltforge/api/oauth'

const COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/

type Seen = (user: SessionUser) => void

export class AppSessions implements SessionResolver {
  constructor(private readonly seen: Seen = () => {}) {}

  async current(req: Request): Promise<SessionUser | null> {
    const cookie = req.headers.get('cookie')
    if (!cookie || !COOKIE.test(cookie)) return null
    try {
      const res = await handler(
        new Request(new URL('/api/auth/get-session', req.url), {
          headers: { cookie },
        }),
      )
      if (!res.ok) return null
      const body = (await res.json()) as {
        user?: { username?: string | null; name?: string }
      } | null
      const handle = body?.user?.username
      if (!handle) return null
      const user = { handle, name: body.user?.name ?? handle }
      this.seen(user)
      return user
    } catch {
      return null
    }
  }

  csrf(req: Request) {
    const token = COOKIE.exec(req.headers.get('cookie') ?? '')?.[1]
    return token
      ? createHash('sha256').update(`oauth-form:${token}`).digest('base64url')
      : null
  }

  logins() {
    return []
  }

  start() {
    return null
  }

  signInUrl(returnTo: string) {
    return `/sign-in?redirect=${encodeURIComponent(returnTo)}`
  }
}
