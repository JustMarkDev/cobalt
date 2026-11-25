import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

/** Providers send bodies of a few hundred kilobytes at most. */
const MAX_BODY = 5 * 1024 * 1024

/**
 * Webhook deliveries from the git providers: the Cobalt GitHub App's one
 * webhook, and one per imported repository on GitLab and Codeberg. They are
 * answered here, in the web process, because it holds the provider secrets.
 */
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
