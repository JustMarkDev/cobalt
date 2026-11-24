import betterAuth from '@convex-dev/better-auth/convex.config'
import presence from '@convex-dev/presence/convex.config'
import { defineApp } from 'convex/server'
import { v } from 'convex/values'

const app = defineApp({
  env: {
    API_STORE_SECRET: v.optional(v.string()),
    SITE_URL: v.optional(v.string()),
    BETTER_AUTH_SECRET: v.optional(v.string()),
    RESEND_API_KEY: v.optional(v.string()),
    API_URL: v.optional(v.string()),
    API_JWT_ISSUER: v.optional(v.string()),
    API_JWT_JWKS: v.optional(v.string()),
    CODE_STORAGE_WEBHOOK_SECRET: v.optional(v.string()),
    POLAR_WEBHOOK_SECRET: v.optional(v.string()),
    POLAR_ACCESS_TOKEN: v.optional(v.string()),
    MAIL_FROM: v.optional(v.string()),
    MAIL_FROM_TEAM: v.optional(v.string()),
    POSTHOG_KEY: v.optional(v.string()),
    POSTHOG_HOST: v.optional(v.string()),
    POSTHOG_PERSONAL_KEY: v.optional(v.string()),
    POSTHOG_PROJECT_ID: v.optional(v.string()),
    POSTHOG_API_HOST: v.optional(v.string()),
  },
})

app.use(betterAuth)
app.use(presence)

export default app
