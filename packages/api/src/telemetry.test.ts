import { afterEach, expect, test } from 'bun:test'
import { createSampleApi } from './index'
import { headersOf } from './telemetry'

/** Spans go to whatever OTLP receiver the environment names, and nowhere without one. */
type Attr = { key: string; value: Record<string, unknown> }
type Span = {
  name: string
  spanId: string
  parentSpanId?: string
  attributes: Array<Attr>
}

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
})

function receiver() {
  const got: Array<{
    path: string
    auth: string | null
    dataset: string | null
    body: any
  }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = new Uint8Array(await req.arrayBuffer())
      const bytes =
        req.headers.get('content-encoding') === 'gzip'
          ? Bun.gunzipSync(raw)
          : raw
      got.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization'),
        dataset: req.headers.get('x-axiom-dataset'),
        body: JSON.parse(new TextDecoder().decode(bytes)),
      })
      return Response.json({})
    },
  })
  return { got, server }
}

const attr = (s: Span, key: string) =>
  Object.values(s.attributes.find((a) => a.key === key)?.value ?? {})[0]

test('every request is a span, with its operation as a child span', async () => {
  const { got, server } = receiver()
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20xaat-1'
  const api = createSampleApi({})
  expect(
    (await api.fetch(new Request('http://x/v1/repos/dana/gitfs?fields=name')))
      .status,
  ).toBe(200)
  expect(
    (await api.fetch(new Request('http://x/v1/repos/nobody/nothing'))).status,
  ).toBe(404)
  await api.dispose()
  await server.stop()
  const traces = got.filter((g) => g.path === '/v1/traces')
  expect(traces.length).toBeGreaterThan(0)
  expect(traces[0].auth).toBe('Bearer xaat-1')
  const spans: Array<Span> = traces.flatMap((t) =>
    t.body.resourceSpans.flatMap((r: any) =>
      r.scopeSpans.flatMap((s: any) => s.spans),
    ),
  )
  const roots = spans.filter((s) => s.name === 'http.server')
  expect(roots.map((s) => attr(s, 'http.response.status_code'))).toEqual([
    200, 404,
  ])
  expect(roots.map((s) => attr(s, 'api.operation'))).toEqual([
    'repos.get',
    'repos.get',
  ])
  // The route, never the query string.
  expect(attr(roots[0], 'url.path')).toBe('/v1/repos/dana/gitfs')
  const op = spans.find((s) => s.name === 'api.repos.get')!
  expect(op.parentSpanId).toBe(roots[0].spanId)
})

test('headers for one signal go only to that signal, and the others stay off', async () => {
  const { got, server } = receiver()
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20xaat-1'
  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'X-Axiom-Dataset=traces-set'
  process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'X-Axiom-Dataset=logs-set'
  const api = createSampleApi({})
  await api.fetch(new Request('http://x/v1/repos/dana/gitfs?fields=name'))
  await api.dispose()
  await server.stop()
  const traces = got.filter((g) => g.path === '/v1/traces')
  expect(traces.length).toBeGreaterThan(0)
  expect(traces.map((t) => t.dataset)).toEqual(traces.map(() => 'traces-set'))
  expect(traces[0].auth).toBe('Bearer xaat-1')
  // Metrics were not named, so none are sent.
  expect(got.filter((g) => g.path === '/v1/metrics')).toHaveLength(0)
})

test('without an endpoint nothing is sent', async () => {
  const { got, server } = receiver()
  const api = createSampleApi({})
  await api.fetch(new Request('http://x/v1/repos/dana/gitfs'))
  await api.dispose()
  await server.stop()
  expect(got).toHaveLength(0)
})

test('headers are read the way OpenTelemetry writes them', () => {
  expect(
    headersOf('Authorization=Bearer%20a=b, X-Axiom-Dataset=cobalt,bad'),
  ).toEqual({ Authorization: 'Bearer a=b', 'X-Axiom-Dataset': 'cobalt' })
  expect(headersOf(undefined)).toEqual({})
})
