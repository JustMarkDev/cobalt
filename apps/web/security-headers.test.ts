import { describe, expect, test } from 'bun:test'
import { withSecurityHeaders } from './security-headers'

describe('withSecurityHeaders', () => {
  test('a page cannot be framed and keeps to https', () => {
    const res = withSecurityHeaders(
      new Response('<html></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    )
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'",
    )
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('a response with its own policy keeps it', () => {
    const own = "sandbox; default-src 'none'"
    const res = withSecurityHeaders(
      new Response('x', { headers: { 'content-security-policy': own } }),
    )
    expect(res.headers.get('content-security-policy')).toBe(own)
    expect(res.headers.has('x-frame-options')).toBe(false)
  })

  test('headers that cannot change are copied, with the body and status', () => {
    const original = Response.redirect('https://x.test/next', 302)
    const res = withSecurityHeaders(original)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://x.test/next')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })
})
