import { Data } from 'effect'

export class NotFound extends Data.TaggedError('NotFound')<{
  readonly what: string
}> {}

export class BackendUnavailable extends Data.TaggedError('BackendUnavailable')<{
  readonly service: string
  readonly cause?: unknown
}> {}

export class InvalidInput extends Data.TaggedError('InvalidInput')<{
  readonly field: string
}> {}

export class Refused extends Data.TaggedError('Refused')<{
  readonly code: string
  readonly message: string
  readonly hint: string | null
  readonly status: number
}> {}

export type AppError = NotFound | BackendUnavailable | InvalidInput | Refused
