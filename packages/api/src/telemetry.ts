import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
  Otlp,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability'

/**
 * Traces, logs and metrics over OpenTelemetry (OTLP/HTTP, JSON, gzip),
 * configured the standard way, from the environment:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   where to send, e.g. https://api.axiom.co
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer xaat-...,X-Axiom-Dataset=source-code
 *   OTEL_EXPORTER_OTLP_TRACES_HEADERS, OTEL_EXPORTER_OTLP_LOGS_HEADERS,
 *   OTEL_EXPORTER_OTLP_METRICS_HEADERS
 *                                 headers for one signal, added to the ones
 *                                 above. When any is set, only the signals
 *                                 that have one are exported (Axiom keeps
 *                                 traces and logs in separate datasets).
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
    const common = headersOf(env.OTEL_EXPORTER_OTLP_HEADERS)
    const resource = {
      serviceName: env.OTEL_SERVICE_NAME ?? 'source-code',
      serviceVersion: env.OTEL_SERVICE_VERSION,
    }
    const traces = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    const logs = env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
    const metrics = env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
    // One set of headers for everything: all three signals, one destination.
    if (traces === undefined && logs === undefined && metrics === undefined)
      return Otlp.layerJson({
        baseUrl: endpoint,
        headers: common,
        resource,
        compression: 'gzip',
      }).pipe(Layer.provide(FetchHttpClient.layer))
    // Per-signal headers: a receiver that keeps each signal in its own place
    // (Axiom's datasets) takes a header per signal. Only the signals named
    // here are exported, so metrics stay off unless their headers are set.
    const base = endpoint.replace(/\/+$/, '')
    const options = (path: string, signal: string) => ({
      url: `${base}${path}`,
      resource,
      headers: { ...common, ...headersOf(signal) },
      compression: 'gzip' as const,
    })
    return Layer.mergeAll(
      traces === undefined
        ? Layer.empty
        : OtlpTracer.layer(options('/v1/traces', traces)),
      logs === undefined
        ? Layer.empty
        : OtlpLogger.layer(options('/v1/logs', logs)),
      metrics === undefined
        ? Layer.empty
        : OtlpMetrics.layer(options('/v1/metrics', metrics)),
    ).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(OtlpSerialization.layerJson),
    )
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
