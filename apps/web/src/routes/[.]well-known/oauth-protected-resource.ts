import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

export const Route = createFileRoute('/.well-known/oauth-protected-resource')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        Response.json(getApi(request.url).oauth!.protectedResource(), {
          headers: {
            'cache-control': 'public, max-age=3600',
            'access-control-allow-origin': '*',
          },
        }),
    },
  },
})
