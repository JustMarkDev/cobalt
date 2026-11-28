import { getApi } from './instance'

/** Smart HTTP for `git clone` and `git push`, served from several routes. */
export const serveGit = async ({ request }: { request: Request }) => {
  const api = getApi(request.url)
  if (!api.gitHttp) return new Response('Not found\n', { status: 404 })
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return api.gitHttp(request, ip)
}
