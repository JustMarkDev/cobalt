import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { allOperations } from '@cobaltforge/api'
import { buildOpenApi } from '@cobaltforge/api/openapi'
import { findBreaking } from '@cobaltforge/api/openapi-diff'

const file = new URL(
  '../packages/api/src/openapi.snapshot.json',
  import.meta.url,
)
const next = buildOpenApi(allOperations())
if (existsSync(file) && !process.argv.includes('--allow-breaking')) {
  const breaking = findBreaking(JSON.parse(readFileSync(file, 'utf8')), next)
  if (breaking.length) {
    console.error(
      'Not additive. v1 only adds.\n' +
        breaking.map((b) => `  - ${b}`).join('\n'),
    )
    process.exit(1)
  }
}
writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
console.log(`wrote ${Object.keys(next.paths as object).length} paths`)
