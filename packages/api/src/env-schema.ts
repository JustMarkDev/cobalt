// `.env.schema`: the variables a repository needs, with Varlock's decorators
// (https://varlock.dev). The file is the source of truth: env.list, env.set
// and env.values read it from the default branch, so a variable exists here
// as soon as its line is merged.
import type { EnvVarRec, Environment } from './extras'
import { ENVIRONMENTS } from './extras'

export type SchemaVar = {
  name: string
  kind: string
  secret: boolean
  required: Array<Environment>
  description: string
}

const decorators = (line: string) => {
  const out = new Map<string, string | true>()
  for (const m of line.matchAll(
    /@([A-Za-z][\w]*)(?:=((?:\([^)]*\)|[^\s])+))?/g,
  )) {
    const value: string | undefined = m.at(2)
    out.set(m[1], value ?? true)
  }
  return out
}

const truthy = (v: string | true | undefined) =>
  v === true || v === 'true' || v === undefined

function requiredOf(v: string | true | undefined): Array<Environment> {
  if (v === undefined || v === 'false') return []
  const only = typeof v === 'string' ? /^forEnv\(([^)]*)\)$/.exec(v) : null
  if (only)
    return only[1]
      .split(',')
      .map((e) => e.trim().replace(/^['"]|['"]$/g, ''))
      .filter((e): e is Environment =>
        (ENVIRONMENTS as ReadonlyArray<string>).includes(e),
      )
  return [...ENVIRONMENTS]
}

/** Every variable the schema names, with what its decorators say. */
export function parseEnvSchema(text: string): Array<SchemaVar> {
  const lines = text.split(/\r?\n/)
  // The header, up to `# ---`, sets defaults for every variable.
  const dash = lines.findIndex((l) => /^#\s*-{3,}\s*$/.test(l))
  const header = dash >= 0 ? lines.slice(0, dash) : []
  const root = decorators(header.join(' '))
  const sensitiveByDefault = truthy(root.get('defaultSensitive') ?? 'true')
  const requiredByDefault = root.get('defaultRequired')
  const out: Array<SchemaVar> = []
  let pending: Array<string> = []
  for (const line of dash >= 0 ? lines.slice(dash + 1) : lines) {
    const t = line.trim()
    if (!t) {
      pending = []
      continue
    }
    if (t.startsWith('#')) {
      pending.push(t.replace(/^#\s?/, ''))
      continue
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(t)
    if (!m) {
      pending = []
      continue
    }
    const d = decorators(pending.join(' '))
    const said = pending
      .map((p) =>
        p.replace(/@[A-Za-z][\w]*(?:=(?:\([^)]*\)|[^\s])+)?/g, '').trim(),
      )
      .filter(Boolean)
      .join(' ')
    const value = m[2].trim()
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
          : requiredByDefault === 'infer'
            ? value
              ? []
              : [...ENVIRONMENTS]
            : []
    const type = d.get('type')
    out.push({
      name: m[1],
      kind:
        typeof type === 'string' ? (type.split('(')[0] ?? 'string') : 'string',
      secret,
      required,
      description: said,
    })
    pending = []
  }
  return out
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
