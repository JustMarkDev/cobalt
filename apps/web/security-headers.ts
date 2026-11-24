export const baseHeaders: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

export function withSecurityHeaders(res: Response): Response {
  const add: Array<[string, string]> = []
  for (const [k, v] of Object.entries(baseHeaders))
    if (!res.headers.has(k)) add.push([k, v])
  if (!res.headers.has('content-security-policy')) {
    add.push(['content-security-policy', "frame-ancestors 'none'"])
    if (!res.headers.has('x-frame-options'))
      add.push(['x-frame-options', 'DENY'])
  }
  if (add.length === 0) return res
  try {
    for (const [k, v] of add) res.headers.set(k, v)
    return res
  } catch {
    const headers = new Headers(res.headers)
    for (const [k, v] of add) headers.set(k, v)
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
}
