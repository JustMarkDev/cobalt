// Mint an API token for a handle on the development deployment, so an agent
// can drive the local app (API, `cb`, MCP) without a password or a browser.
//
//   bun scripts/dev/token.ts mark            # prints cb_pat_...
//   bun scripts/dev/token.ts mark --ttl 3600 # seconds, default one day
//
// Reads `.env.local` and `apps/web/.env.local`. Refuses anything that is not a
// `dev:` deployment: production tokens come from the settings page.
import { allScopes } from '@cobaltforge/api/auth'
import { convexHttpCall } from '@cobaltforge/api/stores/convex-http'
import { run } from '@cobaltforge/api/domain/convex'
import { devEnv } from './env'

const handle = process.argv[2]
if (!handle) {
  console.error('usage: bun scripts/dev/token.ts <handle> [--ttl seconds]')
  process.exit(2)
}
const ttlAt = process.argv.indexOf('--ttl')
const ttl = ttlAt > 0 ? Number(process.argv[ttlAt + 1]) : 86_400

const env = devEnv()
const call = convexHttpCall(env.convexUrl, env.signer)
const minted = await run<{ secret: string }>(
  call,
  'mutation',
  'forge/tokens:create',
  {
    name: `dev agent (${new Date().toISOString().slice(0, 16)})`,
    kind: 'personal',
    handle,
    scopes: [...allScopes],
    repos: null,
    paths: null,
    ttlMs: ttl * 1000,
  },
  'system',
)
console.log(minted.secret)
