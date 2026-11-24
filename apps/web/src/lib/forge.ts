import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
import {
  queryOptions,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { useConvex, useConvexAuth } from 'convex/react'
import { Effect } from 'effect'
import * as React from 'react'
import { screenRead, screenWrite } from '@cobaltforge/api/screens'
import type { QueryClient } from '@tanstack/react-query'
import type { OperationId, Operations } from '@cobaltforge/sdk'
import type { Reader } from '@cobaltforge/api/screens'
import { InvalidInput } from '~/lib/effect/errors'
import { authClient } from '~/lib/auth/client'

type WriteOptions = { ifMatch?: string; dryRun?: boolean }

export type Refusal = {
  code: string
  message: string
  hint: string | null
  status: number
}

type Wire = { ok: true; json: string } | { ok: false; refused: Refusal | null }

const callForge = createServerFn({ method: 'POST' })
  .validator((d: { id: string; input: string; options?: WriteOptions }) => d)
  .handler(async ({ data }): Promise<Wire> => {
    const [{ runServer }, { Forge }, { getRequest }, { getApi }] =
      await Promise.all([
        import('~/lib/effect/runtime'),
        import('~/lib/effect/services/forge'),
        import('@tanstack/react-start/server'),
        import('~/lib/api/instance'),
      ])
    const request = getRequest()
    const found = getApi(request.url).ops.find((o) => o.id === data.id)
    const program = Effect.gen(function* () {
      if (!found) return yield* new InvalidInput({ field: 'id' })
      if (found.method !== 'GET' && !sameOrigin(request))
        return yield* new InvalidInput({ field: 'origin' })
      const forge = yield* Forge
      const value = yield* forge.call(
        data.id as OperationId,
        JSON.parse(data.input) as never,
        data.options,
      )
      if (value instanceof Response)
        return yield* new InvalidInput({ field: 'id' })
      return { ok: true as const, json: JSON.stringify(value ?? null) }
    }).pipe(
      Effect.catchTag('NotFound', () =>
        Effect.succeed({ ok: false as const, refused: null }),
      ),
      Effect.catchTag('Refused', (r) =>
        Effect.succeed({
          ok: false as const,
          refused: {
            code: r.code,
            message: r.message,
            hint: r.hint,
            status: r.status,
          },
        }),
      ),
    )
    return runServer(program)
  })

function sameOrigin(request: Request) {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = request.headers.get('origin')
  if (!origin) return false
  const here = process.env.CB_PUBLIC_URL ?? new URL(request.url).origin
  return origin === new URL(here).origin
}

export class ForgeRefused extends Error {
  readonly code: string
  readonly hint: string | null
  readonly status: number
  readonly moved_to: string | null
  constructor(r: Refusal, movedTo?: string) {
    super(r.message)
    this.moved_to = movedTo ?? null
    this.name = 'ForgeRefused'
    this.code = r.code
    this.hint = r.hint
    this.status = r.status
  }
}

async function send<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
  options?: WriteOptions,
): Promise<
  { found: true; value: Operations[TId]['output'] } | { found: false }
> {
  const wire = await callForge({
    data: { id, input: JSON.stringify(input), options },
  })
  if (wire.ok)
    return {
      found: true,
      value: JSON.parse(wire.json) as Operations[TId]['output'],
    }
  if (wire.refused) throw new ForgeRefused(wire.refused)
  return { found: false }
}

export async function op<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
  options?: WriteOptions,
): Promise<Operations[TId]['output']> {
  const r = await send(id, input, options)
  if (!r.found) throw notFound()
  return r.value
}

export async function opOrNull<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
): Promise<Operations[TId]['output'] | null> {
  try {
    const r = await send(id, input)
    return r.found ? r.value : null
  } catch (e) {
    if (e instanceof ForgeRefused) return null
    throw e
  }
}

const STALE = 15_000

type Out<TId extends OperationId> = Operations[TId]['output']

export function refusalOf(
  e: unknown,
): (Refusal & { from?: string; to?: string }) | null {
  const data = (e as { data?: unknown } | null)?.data
  if (data && typeof data === 'object' && 'code' in data && 'detail' in data) {
    const d = data as {
      code: string
      detail: string
      from?: string
      to?: string
    }
    return {
      code: d.code,
      message: d.detail,
      hint: null,
      status: 0,
      from: d.from,
      to: d.to,
    }
  }
  if (
    e instanceof Error &&
    /ArgumentValidationError|Validator error/.test(e.message)
  )
    return {
      code: 'invalid_request',
      message: 'That is not a valid request.',
      hint: null,
      status: 400,
    }
  return null
}

export function opQuery<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
  reader: Reader = { handle: null },
) {
  const live = screenRead(id, input, reader, Date.now())
  if (live)
    return queryOptions({
      ...convexQuery(live.fn, live.args),
      select: (text: string) => live.answer(text) as Out<TId>,
    }) as unknown as ReturnType<typeof apiQuery<TId>>
  return apiQuery(id, input)
}

const apiQuery = <TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
) =>
  queryOptions({
    queryKey: ['cb', id, input] as const,
    queryFn: () => op(id, input),
    staleTime: STALE,
  })

export const opQueryOrNull = <TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
) =>
  screenRead(id, input, { handle: null }, Date.now())
    ? (opQuery(id, input) as unknown as ReturnType<typeof apiQueryOrNull<TId>>)
    : apiQueryOrNull(id, input)

const apiQueryOrNull = <TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
) =>
  queryOptions({
    queryKey: ['cb', id, input, 'or-null'] as const,
    queryFn: () => opOrNull(id, input),
    staleTime: STALE,
  })

export async function loadOp<TId extends OperationId>(
  queries: QueryClient,
  id: TId,
  input: Operations[TId]['input'],
) {
  try {
    return await queries.ensureQueryData(opQuery(id, input))
  } catch (e) {
    const r = refusalOf(e)
    if (!r) throw e
    if (r.code === 'not_found') throw notFound()
    throw new ForgeRefused(r, r.to)
  }
}

function useReader(): Reader {
  const handle = authClient.useSession().data?.user.handle ?? null
  return React.useMemo(() => ({ handle }), [handle])
}

function useConvexReady() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const { data, isPending } = authClient.useSession()
  if (isPending || isLoading) return false
  return data ? isAuthenticated : true
}

let ready = false
let waiting: { promise: Promise<void>; resolve: () => void } | null = null
const whenReady = () => {
  if (!waiting) {
    let resolve = () => {}
    const promise = new Promise<void>((r) => (resolve = r))
    waiting = { promise, resolve }
    setTimeout(resolve, 5_000)
  }
  return waiting.promise
}

export function ConvexSignIn() {
  const now = useConvexReady()
  React.useEffect(() => {
    ready = now
    if (now && waiting) {
      waiting.resolve()
      waiting = null
    }
  }, [now])
  return null
}

const inBrowser = typeof window !== 'undefined'

function useOptions<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
) {
  const reader = useReader()
  const key = JSON.stringify(input)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `input`
  return React.useMemo(() => opQuery(id, input, reader), [id, key, reader])
}

const isLive = (key: ReadonlyArray<unknown>) => key[0] === 'convexQuery'

export function useOp<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
): Out<TId> {
  const options = useOptions(id, input)
  const queries = useQueryClient()
  if (
    inBrowser &&
    !ready &&
    isLive(options.queryKey) &&
    queries.getQueryData(options.queryKey) === undefined
  )
    React.use(whenReady())
  return useSuspenseQuery(options).data
}

export function useOpMaybe<TId extends OperationId>(
  id: TId,
  input: Operations[TId]['input'],
  enabled = true,
): Out<TId> | null | undefined {
  const options = useOptions(id, input)
  const live = isLive(options.queryKey)
  const convexReady = useConvexReady()
  const wait = live && !(enabled && convexReady)
  const q = useQuery(
    (wait
      ? { queryKey: ['convexQuery', id, 'skip'], enabled: false }
      : live
        ? options
        : { ...opQueryOrNull(id, input), enabled }) as typeof options,
  )
  if (live && q.isError) return null
  return q.data
}

export type WriteResult<TValue> =
  | { data: TValue; error: null }
  | { data: null; error: { code: string; message: string } }

const unavailable = {
  code: 'unavailable',
  message: 'Something went wrong on our side. Try again.',
}

export function useWrite() {
  const queries = useQueryClient()
  const convex = useConvex()
  return React.useCallback(
    async <TId extends OperationId>(
      id: TId,
      input: Operations[TId]['input'],
      options?: WriteOptions,
    ): Promise<WriteResult<Out<TId>>> => {
      const live = options ? null : screenWrite(id, input)
      try {
        if (live) {
          const text = (await convex.mutation(live.fn, live.args)) as string
          return { data: live.answer(text) as Out<TId>, error: null }
        }
        const r = await send(id, input, options)
        if (!r.found)
          return {
            data: null,
            error: {
              code: 'not_found',
              message: 'That no longer exists, or you may not change it.',
            },
          }
        return { data: r.value, error: null }
      } catch (e) {
        if (e instanceof ForgeRefused)
          return { data: null, error: { code: e.code, message: e.message } }
        const r = live && refusalOf(e)
        if (r)
          return { data: null, error: { code: r.code, message: r.message } }
        return { data: null, error: unavailable }
      } finally {
        if (!options?.dryRun)
          await queries.invalidateQueries({ queryKey: ['cb'] })
      }
    },
    [queries, convex],
  )
}
