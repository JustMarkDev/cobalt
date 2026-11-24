import { z } from 'zod'
import { errorCatalog } from './problem'
import { API_VERSION, PAGE, WAIT_MAX } from './pipeline'
import { Problem } from './schemas'
import { pools } from './limiter'
import type { Op } from './registry'

type Json = Record<string, unknown>

function jsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  defs: Json,
): Json {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    reused: 'inline',
  }) as Json
  const found = (out.$defs ?? {}) as Json
  Object.assign(defs, io === 'output' ? relax(found) : found)
  delete out.$defs
  delete out.$schema
  return (io === 'output' ? relax(out) : out) as Json
}

function relax(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relax)
  if (value && typeof value === 'object') {
    const o: Json = {}
    for (const [k, v] of Object.entries(value as Json)) {
      if (k === 'additionalProperties' && v === false) continue
      o[k] = relax(v)
    }
    return o
  }
  return value
}

const rewriteRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (value && typeof value === 'object') {
    const o: Json = {}
    for (const [k, v] of Object.entries(value as Json))
      o[k] =
        k === '$ref' && typeof v === 'string'
          ? v.replace('#/$defs/', '#/components/schemas/')
          : rewriteRefs(v)
    return o
  }
  return value
}

function parameters(op: Op, defs: Json): Array<Json> {
  const out: Array<Json> = []
  for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
    const prop = op.params
      ? (jsonSchema(op.params, 'input', defs).properties as Json | undefined)?.[
          m[1]
        ]
      : undefined
    out.push({
      name: m[1],
      in: 'path',
      required: true,
      schema: prop ?? { type: 'string' },
    })
  }
  if (op.query) {
    const js = jsonSchema(op.query, 'input', defs)
    const required = new Set((js.required as Array<string> | undefined) ?? [])
    for (const [name, schema] of Object.entries((js.properties ?? {}) as Json))
      out.push({ name, in: 'query', required: required.has(name), schema })
  }
  if (op.shapeable)
    out.push({
      name: 'fields',
      in: 'query',
      required: false,
      description:
        'Comma list of fields to return, dotted for nested. `object` and `id` always stay.',
      schema: { type: 'string' },
    })
  if (op.waitOn)
    out.push({
      name: 'wait',
      in: 'query',
      required: false,
      description: `With If-None-Match: hold the request up to this many seconds until the ETag would change. 0 to ${WAIT_MAX}.`,
      schema: { type: 'integer', minimum: 0, maximum: WAIT_MAX },
    })
  if (op.dryRun)
    out.push({
      name: 'dry_run',
      in: 'query',
      required: false,
      description:
        'Run every check and change nothing. The answer is what would have been returned, with Cb-Dry-Run: true.',
      schema: { type: 'boolean' },
    })
  return out
}

function operationErrors(op: Op): Array<string> {
  const out = new Set<string>([
    ...(op.errors ?? []),
    ...(op.pool === 'none' ? [] : ['rate_limited']),
    'concurrency_limited',
    'internal',
    'backend_unavailable',
    'unsupported_version',
  ])
  if (op.auth !== 'none')
    for (const code of ['token_invalid', 'token_expired', 'token_revoked'])
      out.add(code)
  if (op.auth === 'required') out.add('unauthenticated')
  if (op.scopes?.length) out.add('insufficient_scope')
  if (op.params || op.query || op.body) out.add('invalid_request')
  if (op.body) {
    out.add('unsupported_media_type')
    out.add('payload_too_large')
  }
  if (op.rawBody) out.add('payload_too_large')
  if (op.method !== 'GET' && !op.secretResponse && !op.secretRequest) {
    out.add('idempotency_key_reused')
    out.add('request_in_progress')
  }
  return [...out].sort()
}

export function buildOpenApi(
  ops: ReadonlyArray<Op>,
  base = 'https://api.cobaltforge.dev/v1',
): Json {
  const inputDefs: Json = {}
  const outputDefs: Json = {}
  const paths = new Map<string, Json>()
  const problemRef = { $ref: '#/components/schemas/Problem' }
  for (const op of [...ops].sort((a, b) =>
    (a.path + a.method).localeCompare(b.path + b.method),
  )) {
    const entry: Json = {
      operationId: op.id,
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      tags: op.tags,
      parameters: parameters(op, inputDefs),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: jsonSchema(op.body, 'input', inputDefs),
                },
              },
            },
          }
        : op.rawBody
          ? {
              requestBody: {
                required: true,
                content: {
                  '*/*': {
                    schema: { type: 'string', format: 'binary' },
                    description:
                      'Send the bytes with the Content-Type declared when the upload was created.',
                  },
                },
              },
            }
          : {}),
      responses: {
        [String(op.status ?? 200)]: {
          description: op.status === 204 ? 'No content' : 'Success',
          headers: {
            'Cb-Request-Id': { schema: { type: 'string' } },
            ...(op.method === 'GET' && op.conditional !== false
              ? { ETag: { schema: { type: 'string' } } }
              : {}),
          },
          ...(op.status === 204
            ? {}
            : {
                content: {
                  [op.responseContentType ?? 'application/json']: {
                    schema:
                      op.responseContentType === 'application/octet-stream' ||
                      op.responseContentType === '*/*'
                        ? { type: 'string', format: 'binary' }
                        : jsonSchema(op.response, 'output', outputDefs),
                  },
                  ...(op.markdown
                    ? { 'text/markdown': { schema: { type: 'string' } } }
                    : {}),
                },
              }),
        },
        ...(op.accepted
          ? {
              '202': {
                description: op.accepted.description,
                headers: {
                  'Cb-Request-Id': { schema: { type: 'string' } },
                  Location: { schema: { type: 'string' } },
                },
                content: {
                  'application/json': {
                    schema: jsonSchema(
                      op.accepted.response,
                      'output',
                      outputDefs,
                    ),
                  },
                },
              },
            }
          : {}),
        ...(op.method === 'GET' && op.conditional !== false
          ? {
              '304': {
                description: 'Not modified. Costs no rate-limit units.',
              },
            }
          : {}),
        default: {
          description: 'An error',
          content: { 'application/problem+json': { schema: problemRef } },
        },
      },
      security:
        op.auth === 'required'
          ? [{ bearer: op.scopes ?? [] }]
          : op.auth === 'optional'
            ? [{}, { bearer: op.scopes ?? [] }]
            : [],
      'x-cb-safety': op.safety,
      'x-cb-idempotent': op.idempotent,
      'x-cb-dry-run': !!op.dryRun,
      'x-cb-pool': op.pool,
      'x-cb-cost': op.pool === 'none' ? 0 : (op.cost ?? 1),
      'x-cb-scopes': op.scopes ?? [],
      'x-cb-errors': operationErrors(op),
      'x-cb-async': !!op.mayBeAsync,
      'x-cb-secret-response': !!op.secretResponse,
      'x-cb-secret-request': !!op.secretRequest,
    }
    let item = paths.get(op.path)
    if (!item) paths.set(op.path, (item = {}))
    item[op.method.toLowerCase()] = entry
  }
  const problem = jsonSchema(Problem, 'output', outputDefs)
  const schemas: Json = { ...inputDefs, ...outputDefs, Problem: problem }
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'cobalt API',
      version: API_VERSION,
      summary: 'The cobalt API',
      description:
        'Everything the web app does, over HTTP. Within v1 we only add fields and endpoints. Clients must ignore members they do not know. Errors are application/problem+json with a stable `code`.',
      license: {
        name: 'Business Source License 1.1',
        url: 'https://cobaltforge.dev/legal/terms',
      },
    },
    servers: [{ url: base }],
    paths: Object.fromEntries(paths),
    components: {
      schemas,
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A token starting cbp_ (personal) or cbo_ (OAuth, such as `cb auth login`). Tokens always expire.',
        },
      },
    },
    'x-cb-errors': Object.fromEntries(
      Object.entries(errorCatalog).map(([code, e]) => [
        code,
        { status: e.status, retryable: e.retryable, exit_code: e.exit },
      ]),
    ),
    'x-cb-pools': Object.fromEntries(
      Object.entries(pools).map(([n, p]) => [
        n,
        { limit: p.limit, window_seconds: p.windowMs / 1000 },
      ]),
    ),
    'x-cb-page': PAGE,
  }
  return rewriteRefs(doc) as Json
}
