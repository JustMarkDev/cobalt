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
import { RESERVED_HANDLES, isValidHandle } from '@source-code/api/handles'
import { seededId } from '@source-code/api/ids'
import type { GenericCtx } from '@convex-dev/better-auth'
import type { AuthFunctions } from '@convex-dev/better-auth'
import type { DataModel } from './_generated/dataModel'

/**
 * Sign-in: Better Auth, with its users, sessions and credentials in the
 * `betterAuth` component's own tables. A login is one person.
 *
 * The person's address is Better Auth's `username`. This file keeps our
 * `accounts` table in step with it: signing up creates the person's account,
 * and changing the address moves the account and leaves the old address
 * redirecting (`handleAliases`), in the same transaction as the change.
 */

const authFunctions: AuthFunctions = internal.auth

export const authComponent = createClient<DataModel>(components.betterAuth, {
  authFunctions,
  triggers: {
    user: {
      onCreate: async (ctx, user) => {
        // Sign-up always sends an address; an account without one has no page.
        if (!user.username) return
        // `mayTake` let this through, so an account already at the address
        // is an unclaimed sample one on a development deployment.
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
        // Taking back one's own earlier address ends its redirect.
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

/**
 * Better Auth only knows its own users. An address is also taken when an
 * organization has it or when it still redirects to someone else, so every
 * sign-up and every change of address asks the `accounts` table too.
 *
 * The seeded sample people (`seed.ts`) have no login. On a deployment whose
 * site is this machine, signing up with one of their addresses claims it,
 * which is how the demo account gets its sample data.
 */
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

/**
 * Attempts per account, whatever address they come from: password guessing
 * against one account, or a flood of reset or verification mail to one
 * inbox, stops after a few tries in the window. Only the HTTP routes can
 * write the count; a query building the auth object skips it.
 */
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

/**
 * Convex builds this once while loading `http.ts`, before any request, so a
 * missing setting must not throw here: it would block every deploy. Instead
 * an unconfigured deployment refuses each sign-in request, and the stand-in
 * secret below never signs anything.
 */
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
        // A new address takes effect only once its owner opens the link,
        // and a verified address must approve the move first: someone who
        // borrows a session cannot move the account (and its password
        // resets) to an address they own.
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: ({ user, newEmail, url }) =>
          sendMail(
            user.email,
            'Confirm the change of your source.code email',
            `Someone asked to change the email of your source.code account from ${user.email} to ${newEmail}.\n\nIf it was you, open this link to approve it:\n\n${url}\n\nIf it was not, ignore this email and change your password.`,
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
    // Sent through Resend when RESEND_API_KEY and MAIL_FROM are set on the
    // deployment; otherwise the link goes to the deployment's log, which is
    // enough while developing. Signing in does not wait for verification.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        sendMail(
          user.email,
          'Confirm your email for source.code',
          `Open this link to confirm ${user.email}:\n\n${url}\n\nIf you did not sign up, ignore this email.`,
        ),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: ({ user, url }) =>
        sendMail(
          user.email,
          'Reset your source.code password',
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

/** The signed-in person, or null. */
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
