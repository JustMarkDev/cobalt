import { createFileRoute } from '@tanstack/react-router'

// Screenshots and recordings on issues and changes, for the page: the API
// takes tokens, not the sign-in cookie, so the page reads them through here.
export const Route = createFileRoute('/uploads/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { rawAsCaller } = await import('~/lib/effect/services/forge')
        const match = request.headers.get('if-none-match')
        return rawAsCaller(
          request,
          `/uploads/${encodeURIComponent(params.id)}/content`,
          match ? { headers: { 'if-none-match': match } } : {},
        )
      },
    },
  },
})
