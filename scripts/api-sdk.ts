/**
 * Writes the TypeScript client, `packages/sdk/index.ts`, from the API's own
 * definitions. Run it after changing an operation or a schema; a test fails
 * until you do.
 *
 *   bun scripts/api-sdk.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { allOperations } from '@cobaltforge/api'
import { buildOpenApi } from '@cobaltforge/api/openapi'
import { formatSource } from '@cobaltforge/api/format'
import { generateSdk } from '@cobaltforge/api/sdk'

export async function sdkSource(): Promise<string> {
  const ops = allOperations()
  const doc = buildOpenApi(ops, 'https://api.cobaltforge.dev/v1')
  return formatSource('index.ts', generateSdk(JSON.parse(JSON.stringify(doc))))
}

if (import.meta.main) {
  mkdirSync('packages/sdk', { recursive: true })
  writeFileSync('packages/sdk/index.ts', await sdkSource())
  console.log('wrote packages/sdk/index.ts')
}
