import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { usernameClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import * as React from 'react'
import { isValidHandle } from '@cobaltforge/api/handles'
import { randomHandle } from '@cobaltforge/api/handles'

export type AuthUser = {
  id: string
  name: string
  email: string
  handle: string
  emailVerified?: boolean
}

export type Session = { user: AuthUser; session: { id: string } }

export type AuthError = { code: string; message: string }
export type AuthResult = { data: Session | null; error: AuthError | null }

const client = createAuthClient({
  plugins: [usernameClient(), convexClient()],
})

export const sessionClient = client

type RawUser = {
  id: string
  name: string
  email: string
  emailVerified?: boolean
  username?: string | null
}

const toUser = (u: RawUser): AuthUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  handle: u.username ?? '',
  emailVerified: u.emailVerified ?? false,
})

const fail = (code: string, message: string): AuthResult => ({
  data: null,
  error: { code, message },
})

const MESSAGES: Partial<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: 'Wrong email or password.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'An account with this email already exists.',
  USERNAME_IS_ALREADY_TAKEN: 'That address is already taken.',
  PASSWORD_TOO_SHORT: 'Use a password of at least 8 characters.',
  INVALID_EMAIL: 'Enter a valid email.',
}

type RawError = { code?: string; message?: string; status?: number } | null

const toError = (error: RawError): AuthError => {
  const code = error?.code ?? 'UNKNOWN'
  return {
    code,
    message:
      MESSAGES[code] ??
      error?.message ??
      'Something went wrong. Try again in a moment.',
  }
}

async function current(): Promise<AuthResult> {
  const { data, error } = await client.getSession()
  if (error) return { data: null, error: toError(error) }
  if (!data) return fail('UNAUTHORIZED', 'Sign in again to continue.')
  return {
    data: { user: toUser(data.user), session: { id: data.session.id } },
    error: null,
  }
}

async function signUp(input: {
  name: string
  email: string
  password: string
  handle?: string
}): Promise<AuthResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await client.signUp.email({
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      password: input.password,
      username: input.handle ?? randomHandle(),
    })
    if (!error) return current()
    if (error.code !== 'USERNAME_IS_ALREADY_TAKEN' || input.handle)
      return { data: null, error: toError(error) }
  }
  return fail('ADDRESS_TAKEN', 'Could not find a free address. Try again.')
}

export const authClient = {
  useSession() {
    const { data, isPending } = client.useSession()
    const user = data?.user as RawUser | undefined
    const id = user?.id
    const name = user?.name
    const email = user?.email
    const handle = user?.username
    const verified = user?.emailVerified ?? false
    const sessionId = data?.session.id
    const session = React.useMemo<Session | null>(
      () =>
        id && name !== undefined && email && sessionId
          ? {
              user: {
                id,
                name,
                email,
                handle: handle ?? '',
                emailVerified: verified,
              },
              session: { id: sessionId },
            }
          : null,
      [id, name, email, handle, verified, sessionId],
    )
    return { data: session, isPending }
  },

  signIn: {
    async email(input: {
      email: string
      password: string
    }): Promise<AuthResult> {
      const { error } = await client.signIn.email({
        email: input.email.trim().toLowerCase(),
        password: input.password,
      })
      return error ? { data: null, error: toError(error) } : current()
    },
  },

  signUp: {
    email(input: {
      name: string
      email: string
      password: string
    }): Promise<AuthResult> {
      return signUp(input)
    },
  },

  async updateUser(
    input: Partial<Pick<AuthUser, 'name' | 'email' | 'handle'>>,
  ): Promise<AuthResult> {
    const before = await current()
    if (!before.data) return before
    const me = before.data.user
    const handle = input.handle?.trim().toLowerCase()
    const renames = handle !== undefined && handle !== me.handle
    if (renames && !isValidHandle(handle))
      return fail('INVALID_ADDRESS', 'Use 1 to 24 letters, numbers or dashes.')
    const email = input.email?.trim().toLowerCase()
    if (email !== undefined && !/^\S+@\S+\.\S+$/.test(email))
      return fail('INVALID_EMAIL', 'Enter a valid email.')
    const name = input.name?.trim()
    if (name !== undefined && !name)
      return fail('INVALID_NAME', 'Enter your full name.')

    const changes = {
      ...(name !== undefined && name !== me.name && { name }),
      ...(renames && { username: handle }),
    }
    if (Object.keys(changes).length) {
      const { error } = await client.updateUser(changes)
      if (error)
        return error.code === 'USERNAME_IS_ALREADY_TAKEN'
          ? fail('ADDRESS_TAKEN', `cobaltforge.dev/${handle} is already taken.`)
          : { data: null, error: toError(error) }
    }
    if (email !== undefined && email !== me.email) {
      const { error } = await client.changeEmail({ newEmail: email })
      if (error) return { data: null, error: toError(error) }
    }
    return current()
  },

  async forgotPassword(input: { email: string }): Promise<{ ok: true }> {
    await client.requestPasswordReset({
      email: input.email.trim().toLowerCase(),
      redirectTo: '/reset-password',
    })
    return { ok: true }
  },

  async resetPassword(input: {
    token: string
    password: string
  }): Promise<{ error: AuthError | null }> {
    const { error } = await client.resetPassword({
      newPassword: input.password,
      token: input.token,
    })
    return { error: error ? toError(error) : null }
  },

  async sendVerification(email: string): Promise<{ error: AuthError | null }> {
    const { error } = await client.sendVerificationEmail({
      email,
      callbackURL: '/settings/accounts',
    })
    return { error: error ? toError(error) : null }
  },

  async signOut(): Promise<void> {
    await client.signOut()
  },
}

export function safeRedirect(to: unknown): string | undefined {
  if (typeof to !== 'string') return undefined
  if (!to.startsWith('/') || to.startsWith('//')) return undefined
  if (/^\/(sign-in|sign-up|forgot-password|reset-password)(?:[/?#]|$)/.test(to))
    return undefined
  return to
}
