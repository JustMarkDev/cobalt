import * as React from 'react'
import { cn } from 'cn'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { CheckIcon } from '@heroicons/react/24/outline'
import { AuthShell, RequireAuth } from '~/components/forge/auth'
import { BrandLogo } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { authClient, safeRedirect } from '~/lib/auth/client'
import { useOpMaybe, useWrite } from '~/lib/forge'
import { startGithubLink } from '~/lib/github-link'
import { fieldShell } from '~/components/ui/input'
import { Callout } from '~/components/ui/callout'

export const Route = createFileRoute('/welcome')({
  head: () => ({ meta: [{ title: 'Welcome · cobalt' }] }),
  validateSearch: (
    s: Record<string, unknown>,
  ): { redirect?: string; verified?: boolean } => ({
    redirect: safeRedirect(s.redirect),
    ...(s.verified === true || s.verified === 1 || s.verified === '1'
      ? { verified: true }
      : {}),
  }),
  component: () => (
    <RequireAuth>
      <Welcome />
    </RequireAuth>
  ),
})

const hosts = [
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'Commits, pull requests, reviews and issues.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    blurb: 'Commits, merge requests and issues.',
  },
  {
    id: 'codeberg',
    name: 'Codeberg',
    blurb: 'Commits, pull requests and issues.',
  },
] as const

function Welcome() {
  const { redirect, verified } = Route.useSearch()
  const router = useRouter()
  const { data: session } = authClient.useSession()
  const handle = session?.user.handle ?? ''
  const links = useOpMaybe('links.list', { handle }, !!handle)?.data ?? []
  const write = useWrite()
  const [error, setError] = React.useState('')
  const connected = hosts.filter((h) => links.some((l) => l.host === h.id))
  const next = redirect ?? (connected.length > 0 ? '/dashboard' : '/new')

  return (
    <AuthShell
      step="Step 3 of 3"
      title="Bring your history with you"
      subtitle="Optional. Copy your projects and activity from where they live now. You can do this any time in Settings."
    >
      {session && <AddressEditor handle={session.user.handle} />}
      {verified && (
        <Callout tone="success" title="Email confirmed">
          Your account is ready. Link where your work lives now, or skip this
          for later.
        </Callout>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border">
        {hosts.map((p) => {
          const link = links.find((l) => l.host === p.id)
          return (
            <li key={p.id} className="space-y-2 px-3.5 py-3">
              <div className="flex items-center gap-3">
                <BrandLogo id={p.id} className="size-5" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {link ? `@${link.login}` : p.blurb}
                  </div>
                </div>
                {link ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                    <CheckIcon className="size-3.5" />
                    Linked
                  </span>
                ) : p.id === 'github' ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      void startGithubLink(
                        write,
                        `/welcome${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}`,
                      ).then((e) => e && setError(e))
                    }
                  >
                    Link
                  </Button>
                ) : (
                  <Badge>Planned</Badge>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {error && <p className="text-xs text-danger">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Linking says who you are there; nobody can sign in with these accounts.
        Where a project came from is only visible to you.
      </p>
      <Button
        variant={connected.length > 0 ? 'brand' : 'outline'}
        size="lg"
        className="w-full"
        onClick={() => router.history.push(next)}
      >
        {connected.length > 0 ? 'Continue' : 'Skip for now'}
      </Button>
    </AuthShell>
  )
}

function AddressEditor({ handle }: { handle: string }) {
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(handle)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = async () => {
    if (value === handle) return setEditing(false)
    setSaving(true)
    setError(null)
    const r = await authClient.updateUser({ handle: value })
    setSaving(false)
    if (r.error) return setError(r.error.message)
    setEditing(false)
  }

  if (!editing)
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Your page</div>
          <div className="truncate font-mono text-sm">
            cobaltforge.dev/{handle}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setValue(handle)
            setEditing(true)
          }}
        >
          Change
        </Button>
      </div>
    )

  return (
    <form
      className="space-y-2 rounded-xl border px-3.5 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor="address" className="block text-xs text-muted-foreground">
        Your page
      </label>
      <span
        className={cn(
          fieldShell,
          'flex h-9 w-full items-center overflow-hidden font-mono text-sm focus-within:border-foreground/40',
          error && 'border-danger',
        )}
      >
        <span
          aria-hidden
          className="flex shrink-0 items-center self-stretch border-r bg-muted/50 px-2.5 text-muted-foreground select-none"
        >
          cobaltforge.dev/
        </span>
        <input
          id="address"
          autoFocus
          value={value}
          onChange={(e) =>
            setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
          }
          autoCapitalize="none"
          spellCheck={false}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 outline-none"
        />
      </span>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={saving}
          onClick={() => {
            setEditing(false)
            setError(null)
          }}
        >
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={saving || !value}>
          {saving ? 'Saving' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
