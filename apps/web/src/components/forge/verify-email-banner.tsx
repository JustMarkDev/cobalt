import * as React from 'react'
import { useRouterState } from '@tanstack/react-router'
import { EnvelopeSimpleIcon } from '@phosphor-icons/react'
import { authClient } from '~/lib/auth/client'

export function useResendVerification(email: string | undefined) {
  const [state, setState] = React.useState<
    'idle' | 'sending' | 'sent' | 'error'
  >('idle')
  const [error, setError] = React.useState<string | null>(null)
  const resend = (callbackURL?: string) => {
    if (!email) return
    setState('sending')
    void authClient.sendVerification(email, callbackURL).then((r) => {
      if (r.error) {
        setError(r.error.message)
        setState('error')
      } else setState('sent')
    })
  }
  return { state, error, resend }
}

export function VerifyEmailBanner() {
  const { data: session } = authClient.useSession()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const user = session?.user
  const { state, error, resend } = useResendVerification(user?.email)
  if (!user || user.emailVerified) return null
  return (
    <div className="border-b border-warning/25 bg-warning/8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2.5 text-sm">
        <EnvelopeSimpleIcon className="size-4 shrink-0 text-warning" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">Confirm your email.</span>{' '}
          <span className="text-muted-foreground">
            We sent a link to{' '}
            <span className="font-medium text-foreground">{user.email}</span>.
          </span>
        </p>
        {state === 'sent' ? (
          <span className="text-muted-foreground">Sent. Check your inbox.</span>
        ) : state === 'error' ? (
          <span className="text-danger">{error}</span>
        ) : (
          <button
            type="button"
            disabled={state === 'sending'}
            onClick={() => resend(pathname)}
            className="focus-ring rounded font-medium underline decoration-border underline-offset-4 hover:decoration-foreground disabled:opacity-60"
          >
            {state === 'sending' ? 'Sending' : 'Send it again'}
          </button>
        )}
      </div>
    </div>
  )
}
