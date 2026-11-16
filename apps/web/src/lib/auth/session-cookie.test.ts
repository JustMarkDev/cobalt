import { describe, expect, test } from 'bun:test'
import { getSessionCookie } from 'better-auth/cookies'
import { hasSessionCookie } from './server'

describe('hasSessionCookie', () => {
  test('agrees with Better Auth on which cookies are a session', () => {
    const cases = [
      'better-auth.session_token=abc.def',
      '__Secure-better-auth.session_token=abc',
      'better-auth-session_token=abc',
      'theme=dark; better-auth.session_token=abc; other=1',
      'better-auth.session_data=abc',
      'better-auth.convex_jwt=eyJ',
      'xbetter-auth.session_token=abc',
      'theme=dark',
      '',
    ]
    for (const cookie of cases)
      expect([cookie, hasSessionCookie(cookie || null)]).toEqual([
        cookie,
        getSessionCookie(new Headers({ cookie })) !== null,
      ])
  })
})
