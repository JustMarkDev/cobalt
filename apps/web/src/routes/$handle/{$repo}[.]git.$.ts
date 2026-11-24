import { createFileRoute } from '@tanstack/react-router'
import { getApi } from '~/lib/api/instance'

/** `git clone` and `git push` over HTTPS, as `/<owner>/<repo>.git/...`. */
const handle = async ({ request }: { request: Request }) => {
  const api = getApi(request.url)
  if (!api.gitHttp) return new Response('Not found\n', { status: 404 })
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return api.gitHttp(request, ip)
}

export const Route = createFileRoute('/$handle/{$repo}.git/$')({
  server: { handlers: { GET: handle, POST: handle } },
})
