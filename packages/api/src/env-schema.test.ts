import { expect, test } from 'bun:test'
import { applyEnvSchema, parseEnvSchema } from './env-schema'
import type { EnvVarRec } from './extras'

// The example from the docs (apps/web/content/docs/reference/env-schema.mdx).
const schema = `# @defaultSensitive=true @defaultRequired=infer
# ---
# Postgres for the app
# @required @type=url
DATABASE_URL=

# @public @type=port
API_PORT=8080

# @required=forEnv(production) @type=string(startsWith=sk_)
STRIPE_KEY=
`

test('names, kinds, secrecy and where each is required', () => {
  expect(parseEnvSchema(schema)).toEqual([
    {
      name: 'DATABASE_URL',
      kind: 'url',
      secret: true,
      required: ['development', 'preview', 'production'],
      description: 'Postgres for the app',
    },
    {
      name: 'API_PORT',
      kind: 'port',
      secret: false,
      required: [],
      description: '',
    },
    {
      name: 'STRIPE_KEY',
      kind: 'string',
      secret: true,
      required: ['production'],
      description: '',
    },
  ])
})

test('the schema adds and updates; a provider secret it does not name stays', () => {
  const env: Array<EnvVarRec> = [
    {
      name: 'FROM_GITHUB',
      kind: 'string',
      secret: true,
      set: [],
      description: 'A secret on GitHub',
    },
    {
      name: 'API_PORT',
      kind: 'string',
      secret: true,
      set: ['development'],
      description: '',
    },
  ]
  expect(applyEnvSchema(env, parseEnvSchema(schema))).toBe(true)
  expect(env.map((v) => [v.name, v.kind, v.secret, v.set])).toEqual([
    ['FROM_GITHUB', 'string', true, []],
    ['API_PORT', 'port', false, ['development']],
    ['DATABASE_URL', 'url', true, []],
    ['STRIPE_KEY', 'string', true, []],
  ])
  expect(applyEnvSchema(env, parseEnvSchema(schema))).toBe(false)
})
