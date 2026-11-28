import { createFileRoute } from '@tanstack/react-router'
import { installPs1 } from '~/lib/install-script'

export const Route = createFileRoute('/install.ps1')({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(installPs1(new URL(request.url).origin), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
