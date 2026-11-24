import { createFileRoute } from '@tanstack/react-router'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createSxMcpServer } from '@cobaltforge/cli/mcp'
import { clientFor } from '@cobaltforge/cli/client'
import { API_MOUNT, getApi } from '~/lib/api/instance'

const unauthorized = (metadata: string, message: string) =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="cobalt", resource_metadata="${metadata}"`,
      },
    },
  )

async function handle({ request }: { request: Request }) {
  const api = getApi(request.url)
  const origin = new URL(request.url).origin
  const metadata = `${process.env.CB_PUBLIC_URL ?? origin}/.well-known/oauth-protected-resource/mcp`
  const token = /^Bearer (\S+)$/i.exec(
    request.headers.get('authorization') ?? '',
  )?.[1]
  if (!token)
    return unauthorized(
      metadata,
      'Sign in required. Send "Authorization: Bearer <token>", or sign in with OAuth.',
    )
  const found = await api.verifyToken(token, 'mcp')
  if (!found.ok)
    return unauthorized(
      metadata,
      found.reason === 'expired'
        ? 'The token expired.'
        : found.reason === 'revoked'
          ? 'The token was revoked.'
          : 'The token is not valid for this server.',
    )
  let client: ReturnType<typeof clientFor>
  let revoke: (() => void) | undefined
  if (found.record.audience.includes('api')) {
    client = clientFor(`${origin}${API_MOUNT}`, token, (req) => api.fetch(req))
  } else {
    const created = await api.port.svc.auth.create({
      name: 'mcp bridge',
      kind: 'oauth',
      handle: found.record.handle,
      actingAs: found.record.actingAs,
      device: found.record.device ?? found.record.name,
      scopes: [...found.record.scopes],
      repos: found.record.repos ? [...found.record.repos] : null,
      audience: ['api'],
      limitKey: found.record.id,
      loginId: found.record.authorizationId ?? found.record.id,
      ttlMs: 60_000,
    })
    client = clientFor(`${origin}${API_MOUNT}`, created.secret, (req) =>
      api.fetch(req),
    )
    revoke = () => void api.port.svc.auth.revoke(created.record.id)
    client.tool = 'MCP'
  }
  const mcp = createMcpHandler(() => createSxMcpServer({ client }))
  try {
    const res = await mcp.fetch(request)
    if (!res.headers.get('content-type')?.includes('text/event-stream'))
      await mcp.close()
    return res
  } finally {
    revoke?.()
  }
}

export const Route = createFileRoute('/mcp')({
  server: { handlers: { GET: handle, POST: handle, DELETE: handle } },
})
