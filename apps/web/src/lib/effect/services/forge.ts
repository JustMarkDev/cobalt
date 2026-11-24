import { CbError, createClient } from '@cobaltforge/sdk'
import { personPrincipal } from '@cobaltforge/api/auth'
import { Context, Effect, Layer } from 'effect'
import { BackendUnavailable, NotFound, Refused } from '../errors'
import type {
  Client,
  OperationId,
  Operations,
  RequestOptions,
} from '@cobaltforge/sdk'
import type { getApi } from '~/lib/api/instance'
import type { CurrentUser } from '~/lib/auth/server'

export class Forge extends Context.Service<
  Forge,
  {
    readonly call: <TId extends OperationId>(
      id: TId,
      input: Operations[TId]['input'],
      options?: RequestOptions,
    ) => Effect.Effect<
      Operations[TId]['output'],
      NotFound | Refused | BackendUnavailable
    >
  }
>()('app/Forge') {}

type Api = Pick<ReturnType<typeof getApi>, 'fetch' | 'fetchAs' | 'port'>

const HELD_MAX = 5000

export class Callers {
  private readonly held = new Map<string, Client>()
  private visitor: Client | undefined

  constructor(
    private readonly api: Api,
    private readonly base: string,
    private readonly now: () => number = Date.now,
  ) {}

  private client(handle?: string): Client {
    return createClient({
      baseUrl: this.base,
      retries: 0,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        return handle
          ? this.api.fetchAs(personPrincipal(handle, this.now()), req)
          : this.api.fetch(req)
      }) as typeof fetch,
    })
  }

  // oxlint-disable-next-line require-await -- a promise, as callers have always awaited
  async for(user: CurrentUser | null): Promise<Client> {
    if (!user) return (this.visitor ??= this.client())
    const have = this.held.get(user.handle)
    if (have) return have
    void this.api.port.knowPerson(user.handle, user.name)
    if (this.held.size >= HELD_MAX)
      this.held.delete(this.held.keys().next().value as string)
    const made = this.client(user.handle)
    this.held.set(user.handle, made)
    return made
  }

  // oxlint-disable-next-line require-await -- a promise, as callers have always awaited
  async raw(user: CurrentUser | null, path: string, init: RequestInit = {}) {
    const req = new Request(`${this.base}${path}`, init)
    return user
      ? this.api.fetchAs(personPrincipal(user.handle, this.now()), req)
      : this.api.fetch(req)
  }

  drop(handle: string) {
    this.held.delete(handle)
  }
}

export const failureOf = (id: string, cause: unknown) => {
  if (!(cause instanceof CbError))
    return new BackendUnavailable({ service: 'api', cause })
  if (cause.status === 404) return new NotFound({ what: id })
  if (cause.status >= 500 || cause.status === 429)
    return new BackendUnavailable({ service: 'api', cause })
  return new Refused({
    code: cause.code,
    message: cause.message,
    hint: cause.hint,
    status: cause.status,
  })
}

export const forgeOver = (
  client: () => Promise<{
    client: Pick<Client, 'call'>
    headers?: Record<string, string>
  }>,
) =>
  Forge.of({
    call: (id, input, options) =>
      Effect.tryPromise({
        try: async () => {
          const found = await client()
          return await found.client.call(id, input, {
            ...options,
            headers: { ...found.headers, ...options?.headers },
          })
        },
        catch: (cause) => failureOf(id, cause),
      }).pipe(Effect.withSpan(`Forge.${id}`)),
  })

let callers: Callers | undefined

export const ForgeLive = Layer.succeed(Forge)(
  forgeOver(async () => {
    const [{ getRequest }, { currentUser }, { API_MOUNT, getApi }] =
      await Promise.all([
        import('@tanstack/react-start/server'),
        import('~/lib/auth/server'),
        import('~/lib/api/instance'),
      ])
    const request = getRequest()
    const api = getApi(request.url)
    callers ??= new Callers(
      api,
      `${process.env.CB_PUBLIC_URL ?? new URL(request.url).origin}${API_MOUNT}`,
    )
    const forwarded = request.headers.get('x-forwarded-for')
    return {
      client: await callers.for(await currentUser()),
      headers: forwarded ? { 'x-forwarded-for': forwarded } : undefined,
    }
  }),
)

export async function rawAsCaller(
  request: Request,
  path: string,
  init?: RequestInit,
) {
  const [{ currentUser }, { API_MOUNT, getApi }] = await Promise.all([
    import('~/lib/auth/server'),
    import('~/lib/api/instance'),
  ])
  const api = getApi(request.url)
  callers ??= new Callers(
    api,
    `${process.env.CB_PUBLIC_URL ?? new URL(request.url).origin}${API_MOUNT}`,
  )
  return callers.raw(await currentUser(), path, init)
}
