import { createFileRoute } from '@tanstack/react-router'
import { installSh } from '~/lib/install-script'

export const Route = createFileRoute('/install.sh')({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(installSh(new URL(request.url).origin), {
          headers: {
            'content-type': 'text/x-shellscript; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
