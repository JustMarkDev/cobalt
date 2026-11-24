import { describe, expect, test } from 'bun:test'
import { getSessionCookie } from 'better-auth/cookies'
import { hasSessionCookie, withoutCloudflareHeaders } from './server'

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

describe('withoutCloudflareHeaders', () => {
  test('drops the headers Cloudflare refuses to see twice, keeps the rest', async () => {
    const request = new Request(
      'https://cobaltforge.dev/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'theme=dark',
          'cf-connecting-ip': '1.2.3.4',
          'cf-ray': 'abc-MXP',
          'cdn-loop': 'cloudflare',
          'x-forwarded-for': '1.2.3.4',
        },
        body: '{"name":"x"}',
      },
    )
    const out = withoutCloudflareHeaders(request)
    expect([...out.headers.keys()].sort()).toEqual([
      'content-type',
      'cookie',
      'x-forwarded-for',
    ])
    expect(out.method).toBe('POST')
    expect(out.url).toBe(request.url)
    expect(await out.text()).toBe('{"name":"x"}')
  })

  test('passes a request without them through untouched', () => {
    const request = new Request('https://cobaltforge.dev/api/auth/get-session')
    expect(withoutCloudflareHeaders(request)).toBe(request)
  })
})
