import { notFound } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { TelemetryLive } from '@cobaltforge/api/telemetry'
import { ForgeLive } from './services/forge'
import type { Forge } from './services/forge'
import type { AppError } from './errors'

export type AppServices = Forge

const AppLayer = Layer.mergeAll(ForgeLive, TelemetryLive)

let runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown> | undefined
const getRuntime = () => (runtime ??= ManagedRuntime.make(AppLayer))

export async function runServer<TValue, TError extends AppError>(
  program: Effect.Effect<TValue, TError, AppServices>,
): Promise<TValue> {
  const settled = await getRuntime().runPromise(
    program.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    ),
  )
  if (settled.ok) return settled.value
  const error: AppError = settled.error
  switch (error._tag) {
    case 'NotFound':
      throw notFound()
    case 'InvalidInput':
      throw new Error(`${error.field} is not valid`)
    case 'BackendUnavailable':
      throw new Error(`${error.service} is unavailable`)
    case 'Refused':
      throw new Error(error.message)
  }
}
