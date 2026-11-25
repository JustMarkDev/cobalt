import type { EnvVarRec, Environment } from '../extras'
import { labelOf } from './labels'

export function environmentOf(name: string): Environment | null {
  const n = name.toLowerCase()
  if (/^(prod|production|live|main)$/.test(n)) return 'production'
  if (/^(preview|staging|stage|qa|test|uat)$/.test(n)) return 'preview'
  if (/^(dev|development|local)$/.test(n)) return 'development'
  return null
}

export function declareSecrets(
  env: Array<EnvVarRec>,
  provider: string,
  names: Array<{ name: string; environment: string | null }>,
) {
  const label = labelOf(provider)
  const byName = new Map<
    string,
    { envs: Set<Environment>; from: Set<string> }
  >()
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n.name)) continue
    const e = byName.get(n.name) ?? { envs: new Set(), from: new Set() }
    const mapped = n.environment ? environmentOf(n.environment) : null
    if (mapped) e.envs.add(mapped)
    e.from.add(n.environment ?? 'the repository')
    byName.set(n.name, e)
  }
  let added = 0
  for (const [name, e] of byName) {
    if (env.some((v) => v.name === name)) continue
    env.push({
      name,
      kind: 'string',
      secret: true,
      set: [],
      description: `A secret on ${label} (${[...e.from].join(', ')}). ${label} never gives out its value: set it here.`,
      ...(e.envs.size ? { required: [...e.envs] } : {}),
    })
    added++
  }
  return added
}
