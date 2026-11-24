import { Duration, Effect } from 'effect'

export function settleWithin<TValue>(
  start: () => PromiseLike<TValue>,
  within: Duration.Input,
): Promise<TValue | null> {
  return Effect.runPromise(
    Effect.tryPromise(start).pipe(
      Effect.timeout(within),
      Effect.match({ onSuccess: (value) => value, onFailure: () => null }),
    ),
  )
}

export { Duration }
