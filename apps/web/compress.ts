const COMPRESSIBLE =
  /^(?:text\/|image\/svg\+xml|application\/(?:json|javascript|xml|wasm|manifest\+json|[a-z.+-]*\+(?:json|xml)))/i

export const MIN_BYTES = 256

export function compressible(contentType: string | null) {
  return contentType !== null && COMPRESSIBLE.test(contentType)
}

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
  if (has(`${path}.br`) || has(`${path}.gz`)) withVary(res.headers)
  return res
}

export function carriesSecrets(pathname: string) {
  return (
    pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/oauth/')
  )
}

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
      new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>,
    ),
    init,
  )
}
