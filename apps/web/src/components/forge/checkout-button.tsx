import * as React from 'react'
import { useAction, useConvexAuth } from 'convex/react'
import { ConvexError } from 'convex/values'
import { Link } from '@tanstack/react-router'
import { api } from '../../../../../convex/_generated/api'
import { Button } from '~/components/ui/button'
import type { PaidPlanId } from '~/lib/pricing'

export function useEurope(): boolean {
  const [europe, setEurope] = React.useState(false)
  React.useEffect(() => {
    try {
      setEurope(
        Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('Europe/'),
      )
    } catch {
      setEurope(false)
    }
  }, [])
  return europe
}

export function billingMessage(e: unknown): string {
  if (e instanceof ConvexError) {
    const d = e.data as { detail?: unknown }
    if (typeof d.detail === 'string') return d.detail
  }
  return 'That did not work. Try again in a moment.'
}

type Props = {
  plan: PaidPlanId
  cycle: 'month' | 'year'
  children: React.ReactNode
  variant?: React.ComponentProps<typeof Button>['variant']
  // An organization to buy the plan for, and how many seats.
  account?: string
  seats?: number
}

export function CheckoutButton({
  plan,
  cycle,
  children,
  variant,
  account,
  seats,
}: Props) {
  const { isAuthenticated, isLoading } = useConvexAuth()
  const checkout = useAction(api.billing.checkout)
  const europe = useEurope()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  if (!isAuthenticated)
    return (
      <Button
        size="lg"
        variant={variant}
        disabled={isLoading}
        render={<Link to="/sign-up" search={{ redirect: '/pricing' }} />}
        nativeButton={false}
      >
        {children}
      </Button>
    )
  const go = async () => {
    setBusy(true)
    setError('')
    try {
      window.location.assign(
        await checkout({
          plan,
          cycle,
          currency: europe ? 'eur' : 'usd',
          ...(account ? { account } : {}),
          ...(seats ? { seats } : {}),
        }),
      )
    } catch (e) {
      setError(billingMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button
        size="lg"
        variant={variant}
        disabled={busy}
        className="w-full"
        onClick={() => void go()}
      >
        {busy ? 'Opening checkout…' : children}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
