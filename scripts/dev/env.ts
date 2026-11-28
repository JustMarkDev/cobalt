import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JWK } from 'jose'

const root = join(import.meta.dir, '..', '..')

function parse(file: string): Record<string, string | undefined> {
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  let key: string | null = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) {
      key = m[1]
      out[key] = m[2].replace(/\s+#.*$/, '')
    } else if (key && line && !line.startsWith('#')) out[key] += `\n${line}`
    else key = null
  }
  for (const k of Object.keys(out))
    out[k] = out[k].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  return out
}

/** The development deployment and the key the local app signs with. */
export function devEnv() {
  const env = {
    ...parse(join(root, '.env.local')),
    ...parse(join(root, 'apps/web/.env.local')),
  }
  const deployment = env.CONVEX_DEPLOYMENT ?? ''
  if (!deployment.startsWith('dev:'))
    throw new Error(
      `CONVEX_DEPLOYMENT is "${deployment}": these scripts only run against a dev: deployment.`,
    )
  const convexUrl = env.CONVEX_URL ?? env.VITE_CONVEX_URL
  if (!convexUrl || !env.API_JWT_PRIVATE_KEY)
    throw new Error(
      'Set VITE_CONVEX_URL in .env.local and API_JWT_PRIVATE_KEY in apps/web/.env.local (see README).',
    )
  return {
    env,
    convexUrl,
    signer: {
      issuer: env.API_JWT_ISSUER ?? 'http://localhost:3000',
      privateJwk: JSON.parse(env.API_JWT_PRIVATE_KEY) as JWK,
    },
  }
}
