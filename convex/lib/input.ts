import { checkBody } from '@cobaltforge/api/bodies'
import { signedIn } from './actor'
import { fail } from './errors'
import type { BodyOf, bodies } from '@cobaltforge/api/bodies'
import type { QueryCtx } from '../_generated/server'

export async function bodyOf<Id extends keyof typeof bodies>(
  ctx: Pick<QueryCtx, 'auth' | 'db'>,
  id: Id,
  value: Record<string, unknown>,
): Promise<BodyOf<Id>> {
  await signedIn(ctx)
  const given: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) given[k] = v
  const r = checkBody(id, given)
  if (!r.ok) fail('invalid_request', r.detail, { errors: r.errors })
  return r.body
}
