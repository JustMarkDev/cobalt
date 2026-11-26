// `.env.schema`: the variables a repository needs, with Varlock's decorators
// (https://varlock.dev). The file is the source of truth: env.list, env.set
// and env.values read it from the default branch, so a variable exists here
// as soon as its line is merged.
import type { EnvVarRec, Environment } from './extras'
import { ENVIRONMENTS } from './extras'
import {
  ParsedEnvSpecFunctionCall,
  parseEnvSpecDotEnvFile,
} from '@env-spec/parser'

export type SchemaVar = {
  name: string
  kind: string
  secret: boolean
  required: Array<Environment>
  description: string
}

type Decorated = { name: string; args: unknown } | string | number | boolean

const decoratorsOf = (
  d: Record<string, { value?: unknown }> | undefined,
): Map<string, Decorated | true> => {
  const out = new Map<string, Decorated | true>()
  for (const [k, v] of Object.entries(d ?? {})) {
    const value = v.value
    if (value instanceof ParsedEnvSpecFunctionCall)
      out.set(k, { name: value.name, args: value.simplifiedArgs })
    else {
      const raw = (value as { value?: unknown } | undefined)?.value
      out.set(
        k,
        raw === undefined || raw === null
          ? true
          : (raw as string | number | boolean),
      )
    }
  }
  return out
}

const truthy = (v: Decorated | true | undefined) =>
  v === true || v === 'true' || v === undefined

function requiredOf(v: Decorated | true | undefined): Array<Environment> {
  if (v === undefined || v === false || v === 'false') return []
  if (typeof v === 'object' && v.name === 'forEnv') {
    const args = Array.isArray(v.args) ? v.args : [v.args]
    return args
      .map((e) => String(e))
      .filter((e): e is Environment =>
        (ENVIRONMENTS as ReadonlyArray<string>).includes(e),
      )
  }
  return [...ENVIRONMENTS]
}

/**
 * Every variable the schema names, with what its decorators say, read with
 * Varlock's own parser (@env-spec/parser).
 */
export function parseEnvSchema(text: string): Array<SchemaVar> {
  let doc: ReturnType<typeof parseEnvSpecDotEnvFile>
  try {
    doc = parseEnvSpecDotEnvFile(text)
  } catch {
    return []
  }
  const root = decoratorsOf(doc.header?.decoratorsObject)
  const sensitiveByDefault = truthy(root.get('defaultSensitive') ?? 'true')
  const requiredByDefault = root.get('defaultRequired')
  return doc.configItems.map((it) => {
    const d = decoratorsOf(it.decoratorsObject)
    const value = (it.value as { value?: unknown } | undefined)?.value
    const hasValue = value !== undefined && value !== null && value !== ''
    const secret = d.has('public')
      ? false
      : d.has('sensitive')
        ? truthy(d.get('sensitive'))
        : sensitiveByDefault
    const required = d.has('required')
      ? requiredOf(d.get('required'))
      : d.has('optional')
        ? []
        : requiredByDefault === true || requiredByDefault === 'true'
          ? [...ENVIRONMENTS]
          : requiredByDefault === 'infer' && !hasValue
            ? [...ENVIRONMENTS]
            : []
    const type = d.get('type')
    return {
      name: it.key,
      kind:
        typeof type === 'object'
          ? type.name
          : typeof type === 'string'
            ? type
            : 'string',
      secret,
      required,
      description: it.description.trim(),
    }
  })
}

/**
 * Bring the repository's variables in line with its schema: add the new ones
 * and take each one's kind, secrecy, requirement and description from it.
 * Variables the schema does not name (a provider's secrets) stay. Says
 * whether anything changed.
 */
export function applyEnvSchema(
  env: Array<EnvVarRec>,
  schema: ReadonlyArray<SchemaVar>,
): boolean {
  let changed = false
  for (const s of schema) {
    const have = env.find((v) => v.name === s.name)
    const want = {
      kind: s.kind,
      secret: s.secret,
      description: s.description,
      ...(s.required.length ? { required: s.required } : {}),
    }
    if (!have) {
      env.push({ name: s.name, set: [], ...want })
      changed = true
      continue
    }
    // What was set here and the schema leaves open stays as it is.
    const description = s.description || have.description
    const required =
      have.required ?? (s.required.length ? s.required : undefined)
    const same =
      have.kind === want.kind &&
      have.secret === want.secret &&
      have.description === description &&
      have.required === required
    if (same) continue
    have.kind = want.kind
    have.secret = want.secret
    have.description = description
    if (required) have.required = required
    changed = true
  }
  return changed
}
