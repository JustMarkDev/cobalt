/**
 * Response compression for `server.ts`. Bun's server sends bodies as they
 * are, so without this every page, API answer and script crossed the network
 * uncompressed (the home page's scripts: 1.1 MB instead of about 0.3 MB).
 *
 * Built files are compressed once, by `precompress.ts` after the build, with
 * brotli and gzip at their best settings; the server picks the copy the client
 * takes. Pages and API answers are made per request and get gzip, which costs
 * well under a millisecond for a large page. Brotli is not used for them: at
 * its default setting it takes about 50 ms on the home page.
 */
/** Types worth compressing. Images other than SVG, archives and fonts are compressed already. */
const COMPRESSIBLE =
  /^(?:text\/|image\/svg\+xml|application\/(?:json|javascript|xml|wasm|manifest\+json|[a-z.+-]*\+(?:json|xml)))/i

/**
 * Below this gzip saves next to nothing, or makes the body bigger: measured on
 * our JSON, 56 bytes become 64 and 150 become 140, where 256 become 170.
 */
export const MIN_BYTES = 256

export function compressible(contentType: string | null) {
  return contentType !== null && COMPRESSIBLE.test(contentType)
}

/** Whether the client accepts `encoding` (a q of 0 refuses it). */
export function accepts(header: string | null, encoding: 'br' | 'gzip') {
  if (!header) return false
  let star: boolean | undefined
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    const ok = q === undefined || Number(q.slice(2)) > 0
    if (name === encoding) return ok
    if (name === '*') star = ok
  }
  return star ?? false
}

function withVary(headers: Headers) {
  const vary = headers.get('vary')
  if (!vary) headers.set('vary', 'Accept-Encoding')
  else if (!/accept-encoding|\*/i.test(vary))
    headers.set('vary', `${vary}, Accept-Encoding`)
}

/**
 * Answers with a built file, picking the copy `precompress.ts` wrote for the
 * encoding the client takes. `has` says whether a built path exists.
 */
export function serveBuilt(
  request: Request,
  path: string,
  has: (path: string) => boolean,
  headers: Record<string, string>,
): Response {
  const file = Bun.file(path)
  const header = request.headers.get('accept-encoding')
  const encoding = (['br', 'gzip'] as const).find(
    (e) => has(`${path}.${e === 'br' ? 'br' : 'gz'}`) && accepts(header, e),
  )
  const res = encoding
    ? new Response(Bun.file(`${path}.${encoding === 'br' ? 'br' : 'gz'}`), {
        headers: {
          ...headers,
          'content-type': file.type,
          'content-encoding': encoding,
        },
      })
    : new Response(file, { headers })
  // Negotiated whenever a compressed copy exists, either kind: a copy can be
  // worth it in brotli and not in gzip.
  if (has(`${path}.br`) || has(`${path}.gz`)) withVary(res.headers)
  return res
}

/**
 * Whether answers under this path carry secrets, and so go uncompressed.
 * Compression can leak a secret through the size of a response that also
 * echoes text an attacker chose (BREACH). Sign-in answers carry session
 * tokens, and the OAuth consent and device pages carry a CSRF token next to
 * the client's name and the code typed in; both are small. Other pages hold
 * no session token, Convex token or CSRF token, and the API authenticates
 * with bearer tokens a third-party page cannot send.
 */
export function carriesSecrets(pathname: string) {
  return (
    pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/oauth/')
  )
}

/**
 * Gzips a response made per request, when it is worth it and the client takes
 * it. Bodies made here rarely state their length, so the start of the body
 * is read to find out: one that ends below `MIN_BYTES` goes as it is, and
 * anything longer streams on, compressed.
 */
export async function compressDynamic(
  request: Request,
  res: Response,
): Promise<Response> {
  if (
    request.method === 'HEAD' ||
    res.body === null ||
    res.status === 204 ||
    res.status === 206 ||
    res.status === 304 ||
    res.headers.has('content-encoding')
  )
    return res
  const type = res.headers.get('content-type')
  // An event stream must reach the client event by event.
  if (!compressible(type) || type!.startsWith('text/event-stream')) return res
  if (/no-transform/i.test(res.headers.get('cache-control') ?? '')) return res
  const length = res.headers.get('content-length')
  if (length !== null && Number(length) < MIN_BYTES) return res
  const headers = new Headers(res.headers)
  withVary(headers)
  const init = { status: res.status, statusText: res.statusText, headers }
  if (!accepts(request.headers.get('accept-encoding'), 'gzip'))
    return new Response(res.body, init)

  const reader = res.body.getReader()
  const head: Array<Uint8Array> = []
  let size = 0
  let ended = false
  while (size < MIN_BYTES) {
    const chunk = await reader.read()
    if (chunk.done) {
      ended = true
      break
    }
    head.push(chunk.value)
    size += chunk.value.byteLength
  }
  if (ended) {
    headers.set('content-length', String(size))
    return new Response(Buffer.concat(head), init)
  }
  // The bytes already read go first, then the rest as it comes.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk)
    },
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  return new Response(
    body.pipeThrough(
      // Bytes in, bytes out; the DOM types only disagree on buffer kinds.
      new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>,
    ),
    init,
  )
}
