import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config'
import { env } from './_generated/server'
import type { AuthConfig } from 'convex/server'

const apiIssuer = env.API_JWT_ISSUER
const apiJwks = env.API_JWT_JWKS

export default {
  providers: [
    getAuthConfigProvider(),
    ...(apiIssuer && apiJwks
      ? [
          {
            type: 'customJwt' as const,
            applicationID: 'convex-forge',
            issuer: apiIssuer,
            jwks: apiJwks,
            algorithm: 'ES256' as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig
