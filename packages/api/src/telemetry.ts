import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { Otlp } from 'effect/observability'

/**
 * Traces, logs and metrics over OpenTelemetry (OTLP/HTTP, JSON, gzip),
 * configured the standard way, from the environment:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   where to send, e.g. https://api.axiom.co
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer xaat-...,X-Axiom-Dataset=source-code
 *   OTEL_SERVICE_NAME             defaults to `source-code`
 *   OTEL_SDK_DISABLED=true        turns it off
 *
 * With no endpoint nothing is exported and nothing is sent: spans stay in
 * memory for the life of the request. Any OTLP receiver works (Axiom,
 * Honeycomb, Grafana, a local collector), so changing where the data goes is
 * a change of environment, not of code.
 *
 * What is measured: every API request is a span (`http.server`) with the
 * operation, status and route, and every operation's handler is a child span
 * named after the operation (`api.issues.list`), so latency per operation
 * is a query on span durations. Effects named with `Effect.fn` add their own.
 */
export const TelemetryLive = Layer.unwrap(
  Effect.sync(() => {
    const env = process.env
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
    if (!endpoint || env.OTEL_SDK_DISABLED === 'true') return Layer.empty
    return Otlp.layerJson({
      baseUrl: endpoint,
      headers: headersOf(env.OTEL_EXPORTER_OTLP_HEADERS),
      resource: {
        serviceName: env.OTEL_SERVICE_NAME ?? 'source-code',
        serviceVersion: env.OTEL_SERVICE_VERSION,
      },
      compression: 'gzip',
    }).pipe(Layer.provide(FetchHttpClient.layer))
  }),
)

/** `k=v,k2=v2`, values URI-encoded, as OpenTelemetry writes headers. */
export function headersOf(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (text ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    out[pair.slice(0, at).trim()] = decodeURIComponent(
      pair.slice(at + 1).trim(),
    )
  }
  return out
}
