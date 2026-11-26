import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute(
  '/$handle/$repo/releases/download/$tag/$asset',
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { rawAsCaller } = await import('~/lib/effect/services/forge')
        const at = `/repos/${encodeURIComponent(params.handle)}/${encodeURIComponent(params.repo)}/releases/${encodeURIComponent(params.tag)}/assets/${encodeURIComponent(params.asset)}`
        const counted = await rawAsCaller(request, `${at}/download`, {
          method: 'POST',
        })
        if (!counted.ok)
          return new Response(`No file ${params.asset} in ${params.tag}.`, {
            status: counted.status === 409 ? 410 : 404,
          })
        const d = (await counted.json()) as {
          content_url: string | null
          source_url?: string | null
        }
        // Kept on the provider it was imported from: counted here, served there.
        if (
          !d.content_url &&
          d.source_url &&
          d.source_url.startsWith('https://')
        )
          return new Response(null, {
            status: 302,
            headers: { location: d.source_url, 'cache-control': 'no-store' },
          })
        if (!d.content_url)
          return new Response(
            `${params.asset} is listed in ${params.tag} but its file is kept elsewhere.`,
            { status: 404 },
          )
        const path = new URL(d.content_url).pathname.replace(/^.*?\/v1/, '')
        return rawAsCaller(request, path)
      },
    },
  },
})
