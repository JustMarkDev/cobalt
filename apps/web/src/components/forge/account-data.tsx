import * as React from 'react'
import { useAction, useConvex, useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { Link } from '@tanstack/react-router'
import { api } from '../../../../../convex/_generated/api'
import { billingMessage } from '~/components/forge/checkout-button'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

type Mine = {
  handle: string
  plan: 'free' | 'solo' | 'team' | 'business'
  source: 'free' | 'subscription' | 'grant'
  until: number | null
  limits: { storageGb: number; transferGb: number; pushGb: number }
  usage: {
    storageBytes: number
    transferBytes: number
    pushBytes: number
    quota: 'storage' | 'transfer' | 'push' | null
  }
  keptUntil: number | null
  deletion: { requested: number | null; purgeAt: number } | null
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en', { dateStyle: 'long' })

const size = (gb: number) =>
  gb < 1 ? `${Math.round(gb * 1000)} MB` : `${Math.round(gb * 100) / 100} GB`

const used = (bytes: number) => size(bytes / 1_000_000_000)

function message(e: unknown): string {
  if (e instanceof ConvexError) {
    const d = e.data as { detail?: unknown }
    if (typeof d.detail === 'string') return d.detail
  }
  return 'That did not work. Try again in a moment.'
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-4 surface rounded-2xl border bg-card p-5">
      {children}
    </section>
  )
}

export function PlanAndData() {
  const raw = useQuery(api.plans.mine)
  const mine = React.useMemo<Mine | null>(
    () => (raw ? (JSON.parse(raw) as Mine) : null),
    [raw],
  )
  if (!mine) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <div className="max-w-2xl space-y-6">
      <Plan mine={mine} />
      <Export />
      <Deletion mine={mine} />
    </div>
  )
}

function Plan({ mine }: { mine: Mine }) {
  const name = mine.plan[0].toUpperCase() + mine.plan.slice(1)
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{name} plan</h2>
          <p className="text-sm text-muted-foreground">
            {mine.source === 'grant' && mine.until
              ? `Given to this account until ${day(mine.until)}.`
              : mine.source === 'subscription'
                ? 'Paid.'
                : 'Free, with no end date. Public repositories.'}
          </p>
        </div>
        {mine.source === 'subscription' ? (
          <Billing />
        ) : (
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/pricing" />}
            nativeButton={false}
          >
            See plans
          </Button>
        )}
      </div>
      <dl className="well space-y-2 rounded-xl border bg-muted/60 p-4 text-sm">
        {(
          [
            [
              'Storage',
              `${used(mine.usage.storageBytes)} of ${size(mine.limits.storageGb)}`,
            ],
            [
              'Transfer out',
              `${used(mine.usage.transferBytes)} of ${size(mine.limits.transferGb)} this month`,
            ],
            ['Mirrors', 'Unlimited'],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {mine.usage.quota && (
        <p className="text-sm text-danger">
          This account is past its Free {mine.usage.quota} allowance, so new
          pushes are paused. Nothing is deleted, and clones and fetches keep
          working. Upgrade, or free up space.
        </p>
      )}
      {mine.keptUntil && (
        <p className="text-sm text-muted-foreground">
          Your subscription ended. Private repositories only read, and can be
          cloned or exported, until {day(mine.keptUntil)}. Upgrade to write
          again, or make a repository public.
        </p>
      )}
    </Card>
  )
}

function Billing() {
  const portal = useAction(api.billing.portal)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const open = async () => {
    setBusy(true)
    setError('')
    try {
      window.location.assign(await portal({}))
    } catch (e) {
      setError(billingMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1 text-right">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void open()}
      >
        {busy ? 'Opening…' : 'Manage billing'}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

function Export() {
  const convex = useConvex()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const download = async () => {
    setBusy(true)
    setError('')
    try {
      const text = await convex.query(api.deletion.exportData, {})
      const url = URL.createObjectURL(
        new Blob([text], { type: 'application/json' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = 'cobalt-export.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <div>
        <h2 className="text-lg font-semibold">Take your data with you</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A file with your profile, preferences, organizations, follows and the
          list of your repositories. Repositories are plain git: clone each one
          to keep its history, with its sealed secrets.
        </p>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button variant="outline" disabled={busy} onClick={() => void download()}>
        {busy ? 'Preparing…' : 'Download my data'}
      </Button>
    </Card>
  )
}

function Deletion({ mine }: { mine: Mine }) {
  const request = useMutation(api.deletion.request)
  const cancel = useMutation(api.deletion.cancel)
  const [typed, setTyped] = React.useState('')
  const [error, setError] = React.useState('')
  const run = (p: Promise<unknown>) =>
    p.then(
      () => setError(''),
      (e: unknown) => setError(message(e)),
    )
  if (mine.deletion)
    return (
      <Card>
        <h2 className="text-lg font-semibold">
          This account will be deleted on {day(mine.deletion.purgeAt)}
        </h2>
        <p className="text-sm text-muted-foreground">
          Until then nothing is lost: your repositories only read, and you can
          clone them and download your data. After that day the account, your
          repositories and what is about you are erased, and cannot be brought
          back.
        </p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button
          variant="outline"
          disabled={mine.deletion.purgeAt <= 0}
          onClick={() => void run(cancel({}))}
        >
          Keep my account
        </Button>
      </Card>
    )
  return (
    <Card>
      <div>
        <h2 className="text-lg font-semibold">Delete my account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This starts 30 days. In them your account and repositories only read:
          you can clone everything, download your data, and change your mind
          with one click. After 30 days your account, the repositories it owns
          and what is about you are erased. What you wrote in other
          people&apos;s repositories stays, under the name “ghost”. Git commits
          keep their author.
        </p>
      </div>
      <label className="block space-y-1.5 text-sm">
        <span className="text-muted-foreground">
          Type <b className="text-foreground">{mine.handle}</b> to confirm
        </span>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button
        variant="danger"
        disabled={typed !== mine.handle}
        onClick={() => void run(request({ confirm: typed }))}
      >
        Delete my account in 30 days
      </Button>
    </Card>
  )
}
