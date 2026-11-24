import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

const handle = ({ request }: { request: Request }) =>
  getApi(request.url).fetch(request)

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PATCH: handle,
      PUT: handle,
      DELETE: handle,
      OPTIONS: handle,
    },
  },
})
