import { oauthScopes } from '@cobaltforge/api/auth'
import {
  ConvexIdempotencyStore,
  ConvexLimitStore,
  convexCaller,
} from '@cobaltforge/api/stores/convex'
import { createSampleApi } from '@cobaltforge/api'
import { createConvexApi } from '@cobaltforge/api/convex-api'
import { AppSessions } from './sessions'

export const API_MOUNT = '/api/v1'

type AppApi = Pick<
  ReturnType<typeof createSampleApi>,
  'fetch' | 'fetchAs' | 'ops' | 'port' | 'oauth' | 'verifyToken'
> & {
  /** Git over HTTPS. Only the real backend has it. */
  gitHttp?: (req: Request, ip?: string) => Promise<Response>
  /** Webhook deliveries from git providers. */
  receiveHook?: (provider: string, req: Request) => Promise<Response>
}

let current: AppApi | undefined

function convexApi(origin: string, sessions: AppSessions) {
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
  const onConvex = convexApi(origin, sessions)
  if (onConvex) {
    current = onConvex
    return current
  }
  // The in-memory sample is only for working on the app on your own machine.
  // A deployment never serves made-up data in place of the real backend.
  if (!live)
    throw new Error(
      'CONVEX_URL and API_JWT_PRIVATE_KEY are required: the API does not serve sample data outside local development.',
    )
  console.warn(
    '[api] No Convex key (API_JWT_PRIVATE_KEY): serving the sample from memory for local development. Nothing written is kept.',
  )
  const api = createSampleApi({
    mount: API_MOUNT,
    base: `${origin}${API_MOUNT}`,
    htmlBase: origin,
    sessions,
    userScopes: () => oauthScopes,
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
