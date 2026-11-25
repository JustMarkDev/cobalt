import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { RequireAuth } from '~/components/forge/auth'
import { PageTitle } from '~/components/forge/bits'
import { BrandLogo } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { ProviderPicker } from '~/components/forge/provider-picker'
import { safeRedirect } from '~/lib/auth/client'
import { useWrite } from '~/lib/forge'
import {
  callbackElsewhere,
  githubCallbackUrl,
  startGithubLink,
} from '~/lib/github-link'

type Search = { code?: string; state?: string; error?: string }

export const Route = createFileRoute('/github/callback')({
  head: () => ({
    meta: [{ title: 'Bring your GitHub repositories · cobalt' }],
  }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.code === 'string' ? { code: s.code } : {}),
    ...(typeof s.state === 'string' ? { state: s.state } : {}),
    ...(typeof s.error === 'string' ? { error: s.error } : {}),
  }),
  component: () => (
    <RequireAuth>
      <Callback />
    </RequireAuth>
  ),
})

type Signed = { access: string; login: string; returnTo: string | null }

function Callback() {
  const { code, state, error: denied } = Route.useSearch()
  const write = useWrite()
  const [signed, setSigned] = React.useState<Signed | null>(null)
  const [error, setError] = React.useState<string | null>(
    denied ? 'GitHub sign-in was cancelled.' : null,
  )
  const traded = React.useRef(false)
  const elsewhere = callbackElsewhere(state)

  React.useEffect(() => {
    if (elsewhere) {
      window.location.replace(`${elsewhere}${window.location.search}`)
      return
    }
    if (traded.current || !code || !state) return
    traded.current = true
    void write('github.oauth.finish', {
      body: { code, state, redirect_uri: githubCallbackUrl() },
    }).then((r) => {
      if (r.error) return setError(r.error.message)
      setSigned({
        access: r.data.access,
        login: r.data.login,
        returnTo: safeRedirect(r.data.return_to) ?? null,
      })
      window.history.replaceState(null, '', '/github/callback')
    })
  }, [code, state, write, elsewhere])

  if (elsewhere)
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-muted-foreground">
        Taking you back to where you started…
      </div>
    )

  if (error || (!code && !signed))
    return (
      <div className="mx-auto max-w-2xl">
        <PageTitle title="Link GitHub" />
        <div className="space-y-4">
          {error && (
            <Callout tone="danger" title="GitHub is not linked">
              {error}
            </Callout>
          )}
          <Button
            variant="brand"
            size="lg"
            onClick={() =>
              void startGithubLink(write, '/settings/accounts').then(
                (e) => e && setError(e),
              )
            }
          >
            Sign in with GitHub again
          </Button>
        </div>
      </div>
    )

  if (!signed)
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-muted-foreground">
        Linking your GitHub account…
      </div>
    )

  return <Picker signed={signed} />
}

function Picker({ signed }: { signed: Signed }) {
  const write = useWrite()
  const [error, setError] = React.useState<string | null>(null)
  const install = React.useCallback(
    () =>
      void startGithubLink(write, signed.returnTo ?? '/settings/accounts', {
        install: true,
      }).then((e) => e && setError(e)),
    [signed.returnTo, write],
  )
  const empty = (
    <EmptyApp
      onMount={() => {
        if (!installTried()) {
          markInstallTried()
          install()
        }
      }}
    />
  )
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title="Bring your GitHub repositories">
        Signed in to GitHub as{' '}
        <span className="font-mono text-foreground">@{signed.login}</span>. Each
        repository you bring stays in sync with GitHub both ways, and its pull
        requests, issues and releases come along as changes, issues and releases
        here. You can detach one from GitHub later in its settings.
      </PageTitle>
      {error && (
        <Callout tone="danger" title="Could not open GitHub">
          {error}
        </Callout>
      )}
      <ProviderPicker
        provider="github"
        githubAccess={signed.access}
        returnTo={signed.returnTo}
        empty={empty}
        actions={
          <Button variant="outline" onClick={install}>
            Choose repositories on GitHub
            <ArrowTopRightOnSquareIcon className="size-4" />
          </Button>
        }
      />
    </div>
  )
}

function EmptyApp({ onMount }: { onMount: () => void }) {
  React.useEffect(onMount, [onMount])
  return (
    <div className="surface space-y-3 rounded-2xl border bg-card p-6 text-sm">
      <div className="flex items-center gap-3">
        <BrandLogo id="github" className="size-5" />
        <span className="font-medium">
          The Cobalt GitHub App is not on any repository yet
        </span>
      </div>
      <p className="text-muted-foreground">
        Open <b>Choose repositories on GitHub</b> and give the app all your
        repositories or just some. Then pick here which to bring.
      </p>
    </div>
  )
}

const TRIED = 'cb-github-install-tried'
const installTried = () => {
  try {
    return Date.now() - Number(sessionStorage.getItem(TRIED) ?? 0) < 120_000
  } catch {
    return true
  }
}
const markInstallTried = () => {
  try {
    sessionStorage.setItem(TRIED, String(Date.now()))
  } catch {}
}
