import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import { username } from 'better-auth/plugins/username'
import { components, internal } from './_generated/api'
import { sendMail } from './lib/mail'
import { tally, track } from './lib/stats'
import { env, query } from './_generated/server'
import authConfig from './auth.config'
import { RESERVED_HANDLES, isValidHandle } from '@cobaltforge/api/handles'
import { seededId } from '@cobaltforge/api/ids'
import type { GenericCtx } from '@convex-dev/better-auth'
import type { AuthFunctions } from '@convex-dev/better-auth'
import type { DataModel } from './_generated/dataModel'

const authFunctions: AuthFunctions = internal.auth

export const authComponent = createClient<DataModel>(components.betterAuth, {
  authFunctions,
  triggers: {
    user: {
      onCreate: async (ctx, user) => {
        if (!user.username) return
        const sample = await ctx.db
          .query('accounts')
          .withIndex('by_handle', (q) => q.eq('handle', user.username!))
          .unique()
        if (sample) {
          await ctx.db.patch('accounts', sample._id, { authId: user._id })
          return
        }
        const at = Date.now()
        await tally(ctx, 'account.created')
        await track(ctx, 'account.created', user.username, { via: 'sign_up' })
        await ctx.db.insert('accounts', {
          kind: 'person',
          handle: user.username,
          name: user.name,
          bio: '',
          authId: user._id,
          publicId: seededId('account', at, user.username),
          created: at,
          updated: at,
          version: 1,
          aclRev: 0,
        })
      },
      onUpdate: async (ctx, user, before) => {
        const account = await ctx.db
          .query('accounts')
          .withIndex('by_authId', (q) => q.eq('authId', user._id))
          .unique()
        if (!account) return
        if (user.name !== before.name)
          await ctx.db.patch('accounts', account._id, { name: user.name })
        if (!user.username || user.username === before.username) return
        await ctx.db.patch('accounts', account._id, { handle: user.username })
        const own = await ctx.db
          .query('handleAliases')
          .withIndex('by_handle', (q) => q.eq('handle', user.username!))
          .unique()
        if (own) await ctx.db.delete('handleAliases', own._id)
        if (before.username)
          await ctx.db.insert('handleAliases', {
            handle: before.username,
            accountId: account._id,
          })
      },
    },
  },
})

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi()

const taken = () =>
  new APIError('UNPROCESSABLE_ENTITY', {
    code: 'USERNAME_IS_ALREADY_TAKEN',
    message: 'That address is already taken.',
  })

async function mayTake(
  ctx: GenericCtx<DataModel>,
  handle: string,
  authId: string | null,
  siteUrl: string,
) {
  const holder: { kind: string; authId: string | null; alias: boolean } | null =
    await ctx.runQuery(internal.accounts.handleHolder, { handle })
  if (!holder) return true
  if (holder.authId) return holder.authId === authId
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(siteUrl)
  return local && authId === null && holder.kind === 'person' && !holder.alias
}

const THROTTLED: Partial<
  Record<string, { field: string; limit: number; windowMs: number }>
> = {
  '/sign-in/email': { field: 'email', limit: 10, windowMs: 15 * 60_000 },
  '/sign-in/username': { field: 'username', limit: 10, windowMs: 15 * 60_000 },
  '/request-password-reset': { field: 'email', limit: 5, windowMs: 3_600_000 },
  '/send-verification-email': { field: 'email', limit: 5, windowMs: 3_600_000 },
}

async function throttle(
  ctx: GenericCtx<DataModel>,
  path: string,
  body: unknown,
) {
  const rule = THROTTLED[path]
  if (!rule || !('runMutation' in ctx)) return
  const raw = (body as Record<string, unknown> | undefined)?.[rule.field]
  if (typeof raw !== 'string' || !raw) return
  const { granted, resetMs } = await ctx.runMutation(
    internal.apiStores.takeAuthLimit,
    {
      key: `auth:${path}:${raw.trim().toLowerCase().slice(0, 320)}`,
      limit: rule.limit,
      windowMs: rule.windowMs,
    },
  )
  if (granted < 1)
    throw new APIError('TOO_MANY_REQUESTS', {
      message: `Too many attempts. Try again in ${Math.ceil(resetMs / 60_000)} minutes.`,
    })
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = env.SITE_URL
  const secret = env.BETTER_AUTH_SECRET
  const configured = Boolean(siteUrl && secret)
  const baseURL = siteUrl ?? 'http://localhost:3000'
  return betterAuth({
    baseURL,
    secret: secret ?? 'unconfigured-every-request-is-refused',
    hooks: {
      before: createAuthMiddleware(async (actx) => {
        if (!configured)
          throw new APIError('SERVICE_UNAVAILABLE', {
            message:
              'Sign-in is not configured: set SITE_URL and BETTER_AUTH_SECRET on the Convex deployment (see convex/convex.config.ts).',
          })
        await throttle(ctx, actx.path, actx.body)
      }),
    },
    database: authComponent.adapter(ctx),
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: ({ user, newEmail, url }) =>
          sendMail(
            user.email,
            'Confirm the change of your cobalt email',
            `Someone asked to change the email of your cobalt account from ${user.email} to ${newEmail}.\n\nIf it was you, open this link to approve it:\n\n${url}\n\nIf it was not, ignore this email and change your password.`,
          ),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const handle = user.username
            if (typeof handle !== 'string')
              throw new APIError('UNPROCESSABLE_ENTITY', {
                code: 'USERNAME_REQUIRED',
                message: 'An account needs an address.',
              })
            if (!(await mayTake(ctx, handle, null, baseURL))) throw taken()
          },
        },
        update: {
          before: async (user, context) => {
            const handle = user.username
            if (typeof handle !== 'string') return
            const me = context?.context.session?.user.id ?? null
            if (!me || !(await mayTake(ctx, handle, me, baseURL))) throw taken()
          },
        },
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        sendMail(
          user.email,
          'Confirm your email for cobalt',
          `Open this link to confirm ${user.email}:\n\n${url}\n\nIf you did not sign up, ignore this email.`,
        ),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: ({ user, url }) =>
        sendMail(
          user.email,
          'Reset your cobalt password',
          `Open this link to choose a new password:\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays as it is.`,
        ),
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 24,
        usernameValidator: (value) =>
          isValidHandle(value) && !RESERVED_HANDLES.has(value),
      }),
      convex({ authConfig }),
    ],
  })
}

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return null
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      handle: user.username ?? null,
    }
  },
})
