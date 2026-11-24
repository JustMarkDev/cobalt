import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

export const Route = createFileRoute(
  '/.well-known/oauth-protected-resource_/mcp',
)({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        Response.json(getApi(request.url).oauth!.mcpResource(), {
          headers: {
            'cache-control': 'public, max-age=3600',
            'access-control-allow-origin': '*',
          },
        }),
    },
  },
})
