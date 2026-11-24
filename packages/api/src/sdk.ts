type Json = Record<string, any>

const identifier = (s: string) =>
  /^[A-Za-z_$][\w$]*$/.test(s) ? s : JSON.stringify(s)

export function tsOf(schema: Json | undefined, indent = ''): string {
  if (!schema || Object.keys(schema).length === 0) return 'unknown'
  if (schema.$ref) return String(schema.$ref).split('/').pop()!
  if ('const' in schema) return JSON.stringify(schema.const)
  if (schema.enum)
    return (schema.enum as Array<unknown>)
      .map((v) => JSON.stringify(v))
      .join(' | ')
  const union = schema.anyOf ?? schema.oneOf
  if (union)
    return (union as Array<Json>).map((s) => tsOf(s, indent)).join(' | ')
  if (Array.isArray(schema.type))
    return (schema.type as Array<string>)
      .map((t) => tsOf({ ...schema, type: t }, indent))
      .join(' | ')
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `Array<${tsOf(schema.items, indent)}>`
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Json>
      const required = new Set<string>(schema.required ?? [])
      const keys = Object.keys(props)
      if (keys.length === 0) {
        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === 'object'
        )
          return `Record<string, ${tsOf(schema.additionalProperties, indent)}>`
        return 'Record<string, unknown>'
      }
      const inner = `${indent}  `
      const lines = keys.map((k) => {
        const doc = props[k].description
          ? `${inner}/** ${String(props[k].description).replace(/\*\//g, '* /').replace(/\n/g, ' ')} */\n`
          : ''
        return `${doc}${inner}${identifier(k)}${required.has(k) ? '' : '?'}: ${tsOf(props[k], inner)}`
      })
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    default:
      return 'unknown'
  }
}

type Op = {
  id: string
  method: string
  path: string
  summary: string
  pathParams: Array<{ name: string; type: string }>
  queryParams: Array<{
    name: string
    type: string
    required: boolean
    doc: string
  }>
  body: string | null
  bodyRequired: boolean
  response: string | null
  raw: boolean
  idempotent: boolean
  safety: string
  rawBody: boolean
  secretResponse: boolean
}

function readOps(doc: Json): Array<Op> {
  const out: Array<Op> = []
  for (const [path, item] of Object.entries<Json>(doc.paths)) {
    for (const [method, op] of Object.entries<Json>(item)) {
      if (!op.operationId) continue
      const params = (op.parameters ?? []) as Array<Json>
      const ok = Object.entries<Json>(op.responses ?? {}).find(([code]) =>
        code.startsWith('2'),
      )
      const content = (ok?.[1].content ?? {}) as Json
      const json = content['application/json']
      const bodyContent = op.requestBody?.content as Json | undefined
      out.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        pathParams: params
          .filter((p) => p.in === 'path')
          .map((p) => ({ name: p.name, type: tsOf(p.schema) })),
        queryParams: params
          .filter((p) => p.in === 'query')
          .map((p) => ({
            name: p.name,
            type: tsOf(p.schema),
            required: !!p.required,
            doc: String(p.schema?.description ?? p.description ?? ''),
          })),
        body: bodyContent?.['application/json']
          ? tsOf(bodyContent['application/json'].schema)
          : null,
        bodyRequired: !!op.requestBody?.required,
        response: (() => {
          const all = Object.entries<Json>(op.responses ?? {})
            .filter(
              ([code, r]) =>
                code.startsWith('2') &&
                (r.content as Json | undefined)?.['application/json'],
            )
            .map(([, r]) =>
              tsOf((r.content as Json)['application/json'].schema),
            )
          if (!all.length) return null
          if ('204' in (op.responses ?? {})) all.push('void')
          return all.join(' | ')
        })(),
        raw: !!ok && !json && Object.keys(content).length > 0,
        idempotent: !!op['x-cb-idempotent'],
        secretResponse: !!op['x-cb-secret-response'],
        safety: op['x-cb-safety'],
        rawBody: !!bodyContent && !bodyContent['application/json'],
      })
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

function inputOf(op: Op): string {
  const fields: Array<string> = []
  for (const p of op.pathParams) fields.push(`${identifier(p.name)}: ${p.type}`)
  for (const q of op.queryParams) {
    if (q.name === 'dry_run') continue
    fields.push(
      `${q.doc ? `/** ${q.doc.replace(/\*\//g, '* /').replace(/\n/g, ' ')} */\n` : ''}${identifier(q.name)}${q.required ? '' : '?'}: ${q.type}`,
    )
  }
  if (op.body) fields.push(`body${op.bodyRequired ? '' : '?'}: ${op.body}`)
  else if (op.rawBody) fields.push('body: BodyInit', 'contentType?: string')
  return fields.length ? `{\n${fields.join('\n')}\n}` : 'Record<string, never>'
}

export function generateSdk(doc: Json): string {
  const ops = readOps(doc)
  const schemas = doc.components.schemas as Record<string, Json>
  const out: Array<string> = []
  out.push(`// Generated by \`bun scripts/api-sdk.ts\` from the OpenAPI document. Do not edit.
//
// A typed client for the cobalt API. No dependencies: it uses \`fetch\`.
//
//   const cb = createClient({ token: process.env.CB_TOKEN })
//   const change = await cb.changes.get({ owner: 'dana', repo: 'gitfs', number: '216' })
//   for await (const issue of cb.paginate('issues.list', { owner: 'dana', repo: 'gitfs' })) console.log(issue.title)
`)
  out.push(`export const API_VERSION = ${JSON.stringify(doc.info.version)}`)
  out.push('')
  out.push('// ----- Objects')
  for (const name of Object.keys(schemas).sort())
    out.push(`export type ${name} = ${tsOf(schemas[name])}\n`)

  out.push('// ----- Operations')
  out.push('export interface Operations {')
  for (const op of ops) {
    out.push(
      `  /** ${op.summary.replace(/\*\//g, '* /')} (\`${op.method} ${op.path}\`) */`,
    )
    out.push(
      `  ${JSON.stringify(op.id)}: {\n    input: ${inputOf(op).replace(/\n/g, '\n    ')}\n    output: ${op.raw ? 'Response' : (op.response ?? 'void')}\n  }`,
    )
  }
  out.push('}')
  out.push('')
  out.push(
    '/** The facts about each operation that the client needs at run time. */',
  )
  out.push('const OPERATIONS = {')
  for (const op of ops)
    out.push(
      `  ${JSON.stringify(op.id)}: ${JSON.stringify({
        method: op.method,
        path: op.path,
        query: op.queryParams.map((q) => q.name).filter((n) => n !== 'dry_run'),
        body: !!op.body,
        rawBody: op.rawBody,
        json: !op.raw,
        idempotent: op.idempotent,
        secretResponse: op.secretResponse,
        safety: op.safety,
      })},`,
    )
  out.push('} as const')
  out.push('')

  out.push('export interface Client extends Core {')
  const groups = new Map<string, Array<Op>>()
  for (const op of ops) {
    const g = op.id.split('.')[0]
    groups.set(g, [...(groups.get(g) ?? []), op])
  }
  const nest = (list: Array<Op>, depth: number): Array<string> => {
    const lines: Array<string> = []
    const direct = list.filter((o) => o.id.split('.').length === depth + 1)
    const deeper = new Map<string, Array<Op>>()
    for (const o of list.filter((x) => x.id.split('.').length > depth + 1)) {
      const k = o.id.split('.')[depth]
      deeper.set(k, [...(deeper.get(k) ?? []), o])
    }
    for (const o of direct) {
      const verb = o.id.split('.')[depth]
      lines.push(
        `${identifier(verb)}: (${inputIsEmpty(o) ? 'input?: Operations["' + o.id + '"]["input"]' : 'input: Operations["' + o.id + '"]["input"]'}, options?: RequestOptions) => Promise<Operations["${o.id}"]["output"]>`,
      )
    }
    for (const [k, sub] of deeper)
      lines.push(`${identifier(k)}: {\n${nest(sub, depth + 1).join('\n')}\n}`)
    return lines
  }
  for (const [g, list] of groups)
    out.push(`  ${identifier(g)}: {\n${nest(list, 1).join('\n')}\n  }`)
  out.push('}')
  out.push('')
  out.push(RUNTIME)
  out.push(GITHUB_SIGN_IN)
  return out.join('\n')
}

function inputIsEmpty(op: Op) {
  return (
    op.pathParams.length === 0 &&
    op.queryParams.filter((q) => q.name !== 'dry_run' && q.required).length ===
      0 &&
    !op.bodyRequired &&
    !op.rawBody
  )
}

const RUNTIME = `// ----- Runtime

export type OperationId = keyof Operations

export type RequestOptions = {
  signal?: AbortSignal
  /** Send \`If-Match\` with the ETag you read, so a write fails if the object moved. */
  ifMatch?: string
  /** Use your own key. Writes that are not naturally idempotent get one made for them. */
  idempotencyKey?: string
  /** Run every check and change nothing. */
  dryRun?: boolean
  /** Hold a conditional read up to this many seconds until the object changes. */
  wait?: number
  headers?: Record<string, string>
}

export type ClientOptions = {
  /** Default: https://api.cobaltforge.dev/v1 */
  baseUrl?: string
  token?: string
  /** Act as an organization you belong to. */
  account?: string
  fetch?: typeof fetch
  /** Retries for requests that are safe to repeat. Default 3. */
  retries?: number
  /** Entries in the ETag cache. Default 500. 0 turns it off. */
  cacheSize?: number
}

/** An answer that was not a success. Every field is in the API's error catalog. */
export class CbError extends Error {
  readonly status: number
  readonly code: string
  readonly hint: string | null
  readonly retryable: boolean
  readonly exitCode: number
  readonly requestId: string | null
  readonly problem: Record<string, unknown>
  constructor(problem: Record<string, any>, status: number, requestId: string | null) {
    super(String(problem.detail ?? problem.title ?? \`HTTP \${status}\`))
    this.name = 'CbError'
    this.status = status
    this.code = String(problem.code ?? 'internal')
    this.hint = typeof problem.hint === 'string' ? problem.hint : null
    this.retryable = problem.retryable === true
    this.exitCode = typeof problem.exit_code === 'number' ? problem.exit_code : 1
    this.requestId = requestId
    this.problem = problem
  }
}

interface Core {
  /** Any operation by id, for code that chooses at run time. */
  call: <K extends OperationId>(id: K, input: Operations[K]['input'], options?: RequestOptions) => Promise<Operations[K]['output']>
  /** Every item of a list, following cursors. */
  paginate: <K extends OperationId>(id: K, input: Operations[K]['input'], options?: RequestOptions) => AsyncGenerator<Item<Operations[K]['output']>, void, undefined>
  /** The headers of the last response, for ETag, rate limits and the request id. */
  readonly last: Headers | null
}

type Item<T> = T extends { data: Array<infer U> } ? U : never

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason)
    }, { once: true })
  })

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : \`\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2)}\`)

export function createClient(options: ClientOptions = {}): Client {
  const base = (options.baseUrl ?? 'https://api.cobaltforge.dev/v1').replace(/\\/$/, '')
  const doFetch = options.fetch ?? fetch
  const maxRetries = options.retries ?? 3
  const cacheSize = options.cacheSize ?? 500
  const cache = new Map<string, { etag: string; body: unknown }>()
  let last: Headers | null = null

  async function call(id: OperationId, input: Record<string, any> = {}, o: RequestOptions = {}): Promise<any> {
    const op = OPERATIONS[id]
    let path = op.path.replace(/\\{(\\w+)\\}/g, (_, k: string) => {
      const v = input[k]
      if (v === undefined || v === null) throw new TypeError(\`\${id} needs \${k}\`)
      return encodeURIComponent(String(v))
    })
    const query = new URLSearchParams()
    for (const k of op.query) if (input[k] !== undefined && input[k] !== null) query.set(k, String(input[k]))
    if (o.dryRun) query.set('dry_run', 'true')
    if (o.wait) query.set('wait', String(o.wait))
    const qs = query.toString()
    if (qs) path += \`?\${qs}\`
    const url = base + path

    const headers: Record<string, string> = { accept: 'application/json', ...o.headers }
    if (options.token) headers.authorization = \`Bearer \${options.token}\`
    if (options.account) headers['cb-account'] = options.account
    if (o.ifMatch) headers['if-match'] = o.ifMatch
    let body: BodyInit | undefined
    if (op.body && input.body !== undefined) {
      body = JSON.stringify(input.body)
      headers['content-type'] = 'application/json'
    } else if (op.rawBody) {
      body = input.body
      if (input.contentType) headers['content-type'] = input.contentType
    }
    const read = op.method === 'GET'
    // A write that is not naturally idempotent is made safe to repeat: the same key is sent every time.
    if (!read && !op.idempotent && !o.dryRun && !op.secretResponse) headers['idempotency-key'] = o.idempotencyKey ?? uuid()
    else if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey
    const cached = read ? cache.get(url) : undefined
    if (cached) headers['if-none-match'] = cached.etag
    const canRetry = read || (op.idempotent && !o.ifMatch) || !!headers['idempotency-key']

    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await doFetch(url, { method: op.method, headers, body, signal: o.signal })
      } catch (e) {
        if (o.signal?.aborted || !canRetry || attempt >= maxRetries) throw e
        await sleep(Math.min(250 * 2 ** attempt, 4000), o.signal)
        continue
      }
      last = res.headers
      if (res.status === 304 && cached) return cached.body
      if (res.ok) {
        if (!op.json) return res
        if (res.status === 204) return undefined
        const text = await res.text()
        const data = text ? JSON.parse(text) : undefined
        const etag = res.headers.get('etag')
        const noStore = (res.headers.get('cache-control') ?? '').includes('no-store')
        if (read && etag && cacheSize > 0 && !noStore) {
          cache.delete(url)
          cache.set(url, { etag, body: data })
          if (cache.size > cacheSize) cache.delete(cache.keys().next().value as string)
        }
        return data
      }
      const text = await res.text()
      let problem: Record<string, any> = {}
      try {
        problem = JSON.parse(text)
      } catch {
        problem = { detail: text.slice(0, 200) }
      }
      // The server says whether a repeat can help; \`Retry-After\` says when.
      const again = canRetry && attempt < maxRetries && (problem.retryable === true || [502, 503, 504].includes(res.status))
      if (!again) throw new CbError(problem, res.status, res.headers.get('cb-request-id'))
      const after = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : Math.min(250 * 2 ** attempt, 4000), o.signal)
    }
  }

  async function* paginate(id: OperationId, input: Record<string, any>, o?: RequestOptions) {
    let cursor: string | undefined
    do {
      const page = (await call(id, { ...input, cursor }, o)) as { data: Array<unknown>; has_more: boolean; next_cursor: string | null }
      yield* page.data
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor)
  }

  const client: Record<string, any> = {
    call,
    paginate,
    get last() {
      return last
    },
  }
  for (const id of Object.keys(OPERATIONS)) {
    const parts = id.split('.')
    let node = client
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts.at(-1)!] = (input?: Record<string, any>, o?: RequestOptions) => call(id as OperationId, input, o)
  }
  return client as Client
}
`

/** Written by hand: the device login for GitHub, on top of the generated operations. */
const GITHUB_SIGN_IN = `
// ----- Signing in with GitHub

/**
 * Signs in with GitHub on the device flow and returns the proof that
 * \`imports.create\` and \`github.repos.list\` take as \`github_access\`.
 * \`onCode\` gets the code to show the person, and where to type it. The proof
 * is good for ten minutes and nothing is stored.
 *
 *   const { access } = await signInWithGitHub(cb, {
 *     onCode: (c) => console.log(\`Open \${c.verification_uri} and enter \${c.user_code}\`),
 *   })
 *   await cb.imports.create({ body: { host: 'github', slug: 'dana/notes', github_access: access } })
 */
export async function signInWithGitHub(
  cb: Client,
  options: {
    onCode: (code: {
      user_code: string
      verification_uri: string
      expires_in: number
    }) => void | Promise<void>
    signal?: AbortSignal
    /** For tests: how to wait. */
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{ access: string; login: string; expires_in: number }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = await cb.github.device.start()
  await options.onCode(start)
  let interval = start.interval * 1000
  const deadline = Date.now() + start.expires_in * 1000
  for (;;) {
    if (options.signal?.aborted) throw new Error('The GitHub sign-in was cancelled.')
    const r = await cb.github.device.poll({
      body: { device_code: start.device_code },
    })
    if (r.status === 'authorized' && r.access && r.login)
      return { access: r.access, login: r.login, expires_in: r.expires_in ?? 600 }
    if (r.status === 'denied') throw new Error('The GitHub sign-in was denied.')
    if (r.status === 'expired' || Date.now() + interval > deadline)
      throw new Error('The GitHub code expired before it was approved.')
    if (r.status === 'slow_down') interval += 5000
    await sleep(interval)
  }
}
`
