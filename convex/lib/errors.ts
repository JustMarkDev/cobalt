import { ConvexError } from 'convex/values'

export type Refusal = {
  code: string
  detail: string
  more?: string
}

export type More = {
  hint?: string
  errors?: ReadonlyArray<{ pointer: string; code: string; message: string }>
  extra?: Record<string, unknown>
  retryAfter?: number
  headers?: Record<string, string>
  retryable?: boolean
}

export function fail(code: string, detail: string, more: More = {}): never {
  const data: Refusal = { code, detail }
  if (Object.keys(more).length) data.more = JSON.stringify(more)
  throw new ConvexError(data)
}

export function moved(from: string, to: string): never {
  throw new ConvexError({
    code: 'moved',
    detail: `${from} moved to ${to}`,
    from,
    to,
  })
}

export function out(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function finish(dry: boolean | undefined, value: unknown): string {
  const text = out(value)
  if (dry)
    throw new ConvexError({ code: 'dry_run', detail: 'dry run', value: text })
  return text
}
