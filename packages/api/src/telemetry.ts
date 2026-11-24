import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
  Otlp,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability'

export const TelemetryLive = Layer.unwrap(
  Effect.sync(() => {
    const env = process.env
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
    if (!endpoint || env.OTEL_SDK_DISABLED === 'true') return Layer.empty
    const common = headersOf(env.OTEL_EXPORTER_OTLP_HEADERS)
    const resource = {
      serviceName: env.OTEL_SERVICE_NAME ?? 'cobalt',
      serviceVersion: env.OTEL_SERVICE_VERSION,
    }
    const traces = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    const logs = env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
    const metrics = env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
    if (traces === undefined && logs === undefined && metrics === undefined)
      return Otlp.layerJson({
        baseUrl: endpoint,
        headers: common,
        resource,
        compression: 'gzip',
      }).pipe(Layer.provide(FetchHttpClient.layer))
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
