import { createSampleApi } from '@cobaltforge/api'
import { AuthStore } from '@cobaltforge/api/auth'
import {
  sampleTokenStore,
  sampleTokens,
  seedBulk,
} from '@cobaltforge/api/sample'

export const HUGE = 'dana/huge'
export const TOKENS = 1000
export const manyToken = (i: number) =>
  `cbp_bench_token_${String(i % TOKENS).padStart(6, '0')}`

class DiscardingBlobs {
  bytes = 0
  readonly capacity = Number.MAX_SAFE_INTEGER
  put() {}
  get() {
    return null
  }
}

export function buildWorld(
  port: number,
  opts: { allowPrivateWebhooks: boolean },
) {
  const auth = sampleTokenStore(Date.now(), new AuthStore())
  for (let i = 0; i < TOKENS; i++)
    auth.add(manyToken(i), {
      name: `bench ${i}`,
      kind: 'personal',
      handle: 'hollis',
      scopes: ['repo:read', 'issues:read', 'pulls:read'],
      ttlMs: 365 * 86_400_000,
    })
  const huge = { limit: 1e12, windowMs: 60_000 }
  const api = createSampleApi({
    ephemeralSecrets: true,
    mount: '/v1',
    base: `http://127.0.0.1:${port}/v1`,
    htmlBase: `http://127.0.0.1:${port}`,
    issuer: `http://127.0.0.1:${port}`,
    tokens: auth,
    pools: {
      read: huge,
      write: huge,
      heavy: huge,
      search: huge,
      anonymous: huge,
    },
    concurrencyPerToken: 1_000_000,
    allowPrivateWebhooks: opts.allowPrivateWebhooks,
    seed: (d) => seedBulk(d, 'dana', 'huge', 10_000, 2_000),
  })
  ;(api.domain.svc.uploads as unknown as { blobs: unknown }).blobs =
    new DiscardingBlobs()
  return api
}

export { sampleTokens }
