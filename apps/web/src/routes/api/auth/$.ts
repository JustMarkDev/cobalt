import { createFileRoute } from '@tanstack/react-router'
import { handler } from '~/lib/auth/server'

const handle = ({ request }: { request: Request }) => handler(request)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
})
