import * as React from 'react'
import { PageTitle } from '~/components/forge/bits'
import {
  ProviderPicker,
  providerLabel,
} from '~/components/forge/provider-picker'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { safeRedirect } from '~/lib/auth/client'
import { useWrite } from '~/lib/forge'
import { providerCallbackUrl, startProviderLink } from '~/lib/provider-link'
import type { OAuthProvider } from '~/lib/provider-link'

type Connected = { login: string; returnTo: string | null }

export function ProviderCallback({
  provider,
  code,
  state,
  denied,
}: {
  provider: OAuthProvider
  code?: string
  state?: string
  denied?: string
}) {
  const write = useWrite()
  const label = providerLabel[provider]
  const [done, setDone] = React.useState<Connected | null>(null)
  const [error, setError] = React.useState<string | null>(
    denied ? `Connecting ${label} was cancelled.` : null,
  )
  const traded = React.useRef(false)

  React.useEffect(() => {
    if (traded.current || !code || !state) return
    traded.current = true
    void write('providers.oauth.finish', {
      provider,
      body: { code, state, redirect_uri: providerCallbackUrl(provider) },
    }).then((r) => {
      if (r.error) return setError(r.error.message)
      setDone({
        login: r.data.connection.login,
        returnTo: safeRedirect(r.data.return_to) ?? null,
      })
      window.history.replaceState(null, '', `/${provider}/callback`)
    })
  }, [code, state, write, provider])

  if (error || (!code && !done))
    return (
      <div className="mx-auto max-w-2xl">
        <PageTitle title={`Connect ${label}`} />
        <div className="space-y-4">
          {error && (
            <Callout tone="danger" title={`${label} is not connected`}>
              {error}
            </Callout>
          )}
          <Button
            variant="brand"
            size="lg"
            onClick={() =>
              void startProviderLink(
                write,
                provider,
                '/settings/accounts',
              ).then((e) => e && setError(e))
            }
          >
            Connect {label} again
          </Button>
        </div>
      </div>
    )

  if (!done)
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-muted-foreground">
        Connecting your {label} account…
      </div>
    )

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title={`Bring your ${label} repositories`}>
        Connected to {label} as{' '}
        <span className="font-mono text-foreground">{done.login}</span>. Each
        repository you bring stays in sync with {label} both ways, and its pull
        requests, issues and releases come along as changes, issues and releases
        here.
      </PageTitle>
      <ProviderPicker provider={provider} returnTo={done.returnTo} />
    </div>
  )
}
