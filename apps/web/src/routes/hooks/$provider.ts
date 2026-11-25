import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

const MAX_BODY = 5 * 1024 * 1024

export const Route = createFileRoute('/hooks/$provider')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const size = Number(request.headers.get('content-length') ?? 0)
        if (size > MAX_BODY)
          return new Response('The delivery is too large.', { status: 413 })
        const api = getApi(request.url)
        if (!api.receiveHook)
          return new Response('Webhooks are not received here.', {
            status: 404,
          })
        return api.receiveHook(params.provider, request)
      },
    },
  },
})
