// Point every GitHub-linked repository of the dev deployment at one GitHub
// App installation: after switching .env.local to the dev app, the links made
// with production's app would otherwise keep asking for its installation.
//
//   bun scripts/dev/use-installation.ts 186316943
import { $ } from 'bun'
import { convexHttpCall } from '@cobaltforge/api/stores/convex-http'
import { run } from '@cobaltforge/api/domain/convex'
import { devEnv } from './env'

const installation = Number(process.argv.at(2))
if (!Number.isInteger(installation) || installation <= 0) {
  console.error('usage: bun scripts/dev/use-installation.ts <installation id>')
  process.exit(2)
}
const env = devEnv()
const call = convexHttpCall(env.convexUrl, env.signer)
const rows = (
  await $`bunx convex data remoteRepos --limit 1000 --format jsonLines`
    .quiet()
    .text()
)
  .split('\n')
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l) as {
        _id: string
        provider: string
        fullName: string
        installation: number | null
      },
  )
  .filter((r) => r.provider === 'github')
for (const r of rows) {
  if (r.installation === installation) continue
  await run(
    call,
    'mutation',
    'forge/providers:patchRemote',
    { id: r._id, patch: { installation } },
    'system',
  )
  console.log(`${r.fullName}: ${r.installation} → ${installation}`)
}
console.log(`${rows.length} GitHub links on installation ${installation}`)
