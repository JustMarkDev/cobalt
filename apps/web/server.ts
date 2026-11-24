/**
 * Serves the production build: `bun run build`, then `bun run start`.
 *
 * `vp build` writes the browser files to `dist/client` and a request handler
 * to `dist/server/server.js`. This puts the two behind one port: a request for
 * a built file gets the file, everything else goes to the handler.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { carriesSecrets, compressDynamic, serveBuilt } from './compress'
import { withSecurityHeaders } from './security-headers'

type Handler = { fetch: (request: Request) => Response | Promise<Response> }

// React and the other packages the server build leaves external pick their
// development or production code from NODE_ENV when they load. A host that
// runs `bun server.ts` without setting it would get development React: slower,
// and about 20 MB more memory once the pages are warm.
process.env.NODE_ENV ??= 'production'

const client = join(import.meta.dir, 'dist', 'client')
if (
  !existsSync(client) ||
  !existsSync(join(import.meta.dir, 'dist', 'server', 'server.js'))
)
  throw new Error('There is no build to serve. Run `bun run build` first.')
// Resolved at run time, so type checking does not need a build to exist.
const entry = new URL('./dist/server/server.js', import.meta.url).href
const app = ((await import(entry)) as { default: Handler }).default

// The build does not change while the server runs, so it is listed once
// rather than looked up on disk for every request.
const built = new Set(
  readdirSync(client, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name)),
)
const has = (path: string) => built.has(path)

/** The built file a path names, or null. Never a path outside `dist/client`. */
function builtFile(pathname: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.endsWith('/') || decoded.includes('\0')) return null
  const path = join(client, decoded)
  if (!path.startsWith(client + sep)) return null
  return built.has(path) ? path : null
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const { pathname } = new URL(request.url)
      const file = builtFile(pathname)
      if (file)
        return withSecurityHeaders(
          serveBuilt(request, file, has, {
            // Files under /assets carry a content hash in their name.
            'cache-control': pathname.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=3600',
          }),
        )
    }
    const res = withSecurityHeaders(await app.fetch(request))
    if (carriesSecrets(new URL(request.url).pathname)) return res
    return await compressDynamic(request, res)
  },
})

// A deploy or a scale-down sends SIGTERM, then SIGKILL after the platform's
// draining time. Stop taking new connections and let the requests already in
// flight finish, so a deploy never cuts a response short.
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log(`${signal}: finishing open requests, then exiting`)
    void server.stop().then(() => process.exit(0))
  })

const ram = process.env.BUN_JSC_forceRAMSize
console.log(
  `cobalt is listening on ${server.url}` +
    (ram ? ` (heap sized for ${Math.round(Number(ram) / 2 ** 20)} MiB)` : ''),
)
