import { Context } from 'effect'
import type { Effect } from 'effect'
import type { z } from 'zod'
import type { Principal, Scope } from './auth'
import type { ApiError, ErrorCode } from './problem'
import type { PoolName } from './limiter'
import type { DomainPort } from './domain'

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export class Domain extends Context.Service<
  Domain,
  {
    readonly run: <TValue>(
      f: (core: DomainPort) => PromiseLike<TValue> | TValue,
    ) => Effect.Effect<TValue, ApiError>
  }
>()('api/Domain') {}

export type Services = Domain

export class Reply<T> {
  constructor(
    readonly body: T,
    readonly init: {
      status?: number
      headers?: Record<string, string>
      etag?: string
    } = {},
  ) {}
}
export const reply = <T>(body: T, init: Reply<T>['init'] = {}) =>
  new Reply(body, init)

export class Pre {
  private made: unknown
  private done = false

  constructor(
    readonly json: string,
    obj: unknown,
    readonly key: string,
  ) {
    if (typeof obj === 'function') this.make = obj as () => unknown
    else {
      this.made = obj
      this.done = true
    }
  }

  private make: (() => unknown) | undefined

  get obj(): unknown {
    if (!this.done) {
      this.made = this.make!()
      this.done = true
    }
    return this.made
  }

  private cached: string | undefined

  get tag(): string {
    return (this.cached ??= cyrb53(this.key).toString(36))
  }

  toJSON() {
    return this.obj
  }
}

export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export class Raw {
  constructor(readonly response: Response) {}
}

type Infer<TSchema> = TSchema extends z.ZodType
  ? z.output<TSchema>
  : Record<string, never>

export type Ctx<TParams, TQuery, TBody> = {
  readonly params: TParams
  readonly query: TQuery
  readonly body: TBody
  readonly method: string
  readonly principal: Principal | null
  readonly requestId: string
  readonly dryRun: boolean
  readonly ifMatch: string | null
  readonly url: URL
  readonly bytes: Uint8Array | null
  readonly signal: AbortSignal
  readonly header: (name: string) => string | null
  readonly base: string
  readonly htmlBase: string
  readonly now: () => number
  readonly dispatch: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>
}

export type OpSpec<
  TParams extends z.ZodType | undefined,
  TQuery extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse extends z.ZodType,
> = {
  id: string
  summary: string
  description?: string
  tags: Array<string>
  method: Method
  path: string
  auth: 'none' | 'optional' | 'required'
  scopes?: Array<Scope>
  pool: PoolName | 'none'
  cost?: number
  safety: 'read' | 'write' | 'destructive'
  idempotent: boolean
  dryRun?: boolean
  params?: TParams
  query?: TQuery
  body?: TBody
  rawBody?: { maxBytes: number }
  response: TResponse
  status?: number
  secretResponse?: boolean
  secretRequest?: boolean
  conditional?: boolean
  responseContentType?: string
  streaming?: boolean
  ifMatch?: boolean
  errors?: Array<ErrorCode>
  shapeable?: boolean
  waitOn?: (
    params: Infer<TParams>,
    query?: unknown,
    domain?: DomainPort,
  ) => string | Promise<string>
  probe?: (
    ctx: Ctx<Infer<TParams>, Infer<TQuery>, Infer<TBody>>,
    domain: DomainPort,
  ) => Promise<string | null>
  markdown?: (object: Record<string, unknown>) => string
  mayBeAsync?: boolean
  accepted?: { response: z.ZodType; description: string }
  handler: (
    ctx: Ctx<Infer<TParams>, Infer<TQuery>, Infer<TBody>>,
  ) => Effect.Effect<
    z.output<TResponse> | Reply<z.output<TResponse>> | Raw | Pre,
    ApiError,
    Services
  >
}

export type Op = OpSpec<
  z.ZodType | undefined,
  z.ZodType | undefined,
  z.ZodType | undefined,
  z.ZodType
>

export function defineOp<
  TParams extends z.ZodType | undefined = undefined,
  TQuery extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse extends z.ZodType = z.ZodType,
>(spec: OpSpec<TParams, TQuery, TBody, TResponse>): Op {
  return spec as unknown as Op
}

type Node = {
  statics: Map<string, Node>
  param: Node | null
  ops: Map<Method, { op: Op; names: Array<string> }>
}

const node = (): Node => ({ statics: new Map(), param: null, ops: new Map() })

export type Match =
  | { kind: 'hit'; op: Op; params: Record<string, string> }
  | { kind: 'method'; allow: Array<Method> }
  | { kind: 'miss' }

export class Router {
  private readonly root = node()

  constructor(ops: ReadonlyArray<Op>) {
    for (const op of ops) {
      let at = this.root
      const names: Array<string> = []
      for (const seg of op.path.split('/').filter(Boolean)) {
        if (seg.startsWith('{')) {
          names.push(seg.slice(1, -1))
          at.param ??= node()
          at = at.param
        } else {
          let next = at.statics.get(seg)
          if (!next) at.statics.set(seg, (next = node()))
          at = next
        }
      }
      if (at.ops.has(op.method))
        throw new Error(`duplicate operation ${op.method} ${op.path}`)
      at.ops.set(op.method, { op, names })
    }
  }

  match(method: string, path: string): Match {
    const values: Array<string> = []
    let at: Node = this.root
    for (const seg of path.split('/').filter(Boolean)) {
      const next = at.statics.get(seg)
      if (next) at = next
      else if (at.param) {
        let value: string
        try {
          value = decodeURIComponent(seg)
        } catch {
          return { kind: 'miss' }
        }
        values.push(value)
        at = at.param
      } else return { kind: 'miss' }
    }
    const hit = at.ops.get(method as Method)
    if (hit) {
      const params: Record<string, string> = {}
      for (let i = 0; i < hit.names.length; i++)
        params[hit.names[i]] = values[i]
      return { kind: 'hit', op: hit.op, params }
    }
    if (at.ops.size) return { kind: 'method', allow: [...at.ops.keys()] }
    return { kind: 'miss' }
  }
}
