import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { EnvelopeOpenIcon } from '@heroicons/react/24/outline'
import { AuthShell, RequireAuth } from '~/components/forge/auth'
import { useResendVerification } from '~/components/forge/verify-email-banner'
import { Button } from '~/components/ui/button'
import { authClient, safeRedirect } from '~/lib/auth/client'

export const Route = createFileRoute('/check-email')({
  head: () => ({ meta: [{ title: 'Check your email · cobalt' }] }),
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(s.redirect),
  }),
  component: () => (
    <RequireAuth>
      <CheckEmail />
    </RequireAuth>
  ),
})

function CheckEmail() {
  const { redirect } = Route.useSearch()
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const email = session?.user.email
  const { state, error, resend } = useResendVerification(email)
  const next = () => void navigate({ to: '/welcome', search: { redirect } })

  return (
    <AuthShell
      step="Step 2 of 3"
      title="Check your email"
      subtitle={
        <>
          We sent a confirmation link to{' '}
          <span className="font-medium text-foreground">{email}</span>. Open it
          to confirm your account.
        </>
      }
      footer={
        state === 'sent' ? (
          'Sent again. It can take a minute to arrive.'
        ) : state === 'error' ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            Nothing yet? Check your spam folder or{' '}
            <button
              type="button"
              disabled={state === 'sending'}
              onClick={() => resend('/dashboard')}
              className="focus-ring rounded font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground disabled:opacity-60"
            >
              {state === 'sending' ? 'sending' : 'send it again'}
            </button>
            .
          </>
        )
      }
    >
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-brand/10 text-brand">
          <EnvelopeOpenIcon className="size-6" />
        </span>
        <p className="text-sm text-muted-foreground">
          You can keep going and confirm later. Until you do, a reminder stays
          at the top of every page.
        </p>
      </div>
      <Button variant="brand" size="lg" className="w-full" onClick={next}>
        Continue
      </Button>
    </AuthShell>
  )
}
