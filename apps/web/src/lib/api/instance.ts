import { MemoryTokenStore, oauthScopes } from '@cobaltforge/api/auth'
import {
  ConvexIdempotencyStore,
  ConvexLimitStore,
  convexCaller,
} from '@cobaltforge/api/stores/convex'
import { createSampleApi } from '@cobaltforge/api'
import { createConvexApi } from '@cobaltforge/api/convex-api'
import { exportWorld } from '@cobaltforge/api/seed-export'
import { AppSessions } from './sessions'

export const API_MOUNT = '/api/v1'

type AppApi = Pick<
  ReturnType<typeof createSampleApi>,
  'fetch' | 'fetchAs' | 'ops' | 'port' | 'oauth' | 'verifyToken'
>

let current: AppApi | undefined

function convexApi(origin: string, sessions: AppSessions, live: boolean) {
  const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL
  const key = process.env.API_JWT_PRIVATE_KEY
  if (!url || !key) return null
  return createConvexApi({
    convexUrl: url,
    jwt: {
      issuer: process.env.API_JWT_ISSUER ?? origin,
      privateJwk: JSON.parse(key),
    },
    storeSecret: process.env.API_STORE_SECRET,
    uploadSecret: process.env.UPLOAD_SECRET ?? key,
    mount: API_MOUNT,
    base: `${origin}${API_MOUNT}`,
    htmlBase: origin,
    sessions,
    userScopes: () => oauthScopes,
    blobFolder: process.env.CB_BLOB_DIR ?? `${process.cwd()}/.data/blobs`,
    seedSample: live
      ? () => {
          const sample = createSampleApi({
            mount: API_MOUNT,
            base: `${origin}${API_MOUNT}`,
            htmlBase: origin,
          })
          return JSON.stringify(
            exportWorld(sample.domain, sample.domain.svc.auth as never),
          )
        }
      : undefined,
  })
}

export function sharedStore(
  url: string | undefined,
  secret: string | undefined,
) {
  if (!url) return null
  if (!secret || secret.length < 16)
    throw new Error(
      'CONVEX_URL is set, so API_STORE_SECRET must be at least 16 characters. Refusing to fall back to per-node memory stores.',
    )
  return convexCaller(url)
}

export function storeConfig(
  explicitUrl: string | undefined,
  frontendUrl: string | undefined,
  secret: string | undefined,
): string | undefined {
  if (explicitUrl) return explicitUrl
  return secret && secret.length >= 16 ? frontendUrl : undefined
}

export function getApi(requestUrl: string) {
  if (current) return current
  const origin = process.env.CB_PUBLIC_URL ?? new URL(requestUrl).origin
  const live = import.meta.env.DEV || process.env.CB_API_SAMPLE_TOKENS === '1'
  const secret = process.env.API_STORE_SECRET
  const url = storeConfig(
    process.env.CONVEX_URL,
    process.env.VITE_CONVEX_URL,
    secret,
  )
  const shared = sharedStore(url, secret)
  const sessions = new AppSessions((user) => {
    void current?.port.knowPerson(user.handle, user.name)
  })
  const onConvex = convexApi(origin, sessions, live)
  if (onConvex) {
    current = onConvex
    return current
  }
  console.warn(
    '[api] No Convex key (API_JWT_PRIVATE_KEY): serving the sample from memory. Nothing written is kept.',
  )
  const api = createSampleApi({
    mount: API_MOUNT,
    base: `${origin}${API_MOUNT}`,
    htmlBase: origin,
    sessions,
    userScopes: () => oauthScopes,
    ...(live ? {} : { tokens: new MemoryTokenStore() }),
    ...(shared && secret
      ? {
          limitStore: new ConvexLimitStore(shared, secret),
          idempotency: new ConvexIdempotencyStore(shared, secret),
        }
      : {}),
  })
  current = api
  return current
}
