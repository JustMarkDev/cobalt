import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { api } from '../../../../../convex/_generated/api'
import { RequireAuth } from '~/components/forge/auth'
import { PageTitle } from '~/components/forge/bits'
import { BrandLogo } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { Select, SelectItem } from '~/components/ui/select'
import { manages, useAccounts } from '~/lib/auth/accounts'
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

type Repo = {
  slug: string
  private: boolean
  linked: string | null
  size_bytes: number
}

type Signed = { access: string; login: string; returnTo: string | null }

/** Sizes as on the pricing page: decimal, 250 MB, 4 GB. */
const size = (n: number) =>
  n < 1e6
    ? `${Math.max(1, Math.round(n / 1e3))} KB`
    : n < 1e9
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.round((n / 1e9) * 100) / 100} GB`

function Callback() {
  const { code, state, error: denied } = Route.useSearch()
  const write = useWrite()
  const [signed, setSigned] = React.useState<Signed | null>(null)
  const [error, setError] = React.useState<string | null>(
    denied ? 'GitHub sign-in was cancelled.' : null,
  )
  // A code works once: React may run this effect twice in development.
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
      // Keep the code out of the history and out of any copied link.
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
  const { me, accounts, active } = useAccounts()
  const owners = accounts.filter((a) => me && manages(a))
  const [ownerId, setOwnerId] = React.useState<string | null>(null)
  const owner =
    owners.find((a) => a.id === ownerId) ??
    owners.find((a) => a.id === active?.id) ??
    owners.at(0)
  const [repos, setRepos] = React.useState<Array<Repo> | null>(null)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [results, setResults] = React.useState<
    Partial<Record<string, { ok: boolean; text: string }>>
  >({})
  const plan = usePlan()

  const install = React.useCallback(
    () =>
      void startGithubLink(write, signed.returnTo ?? '/settings/accounts', {
        install: true,
      }).then((e) => e && setError(e)),
    [signed.returnTo, write],
  )

  const load = React.useCallback(async () => {
    const r = await write('github.repos.list', {
      body: { access: signed.access },
    })
    if (r.error) return setError(r.error.message)
    setError(null)
    setRepos(r.data.data)
    // The app sees nothing yet: go and install it, once per visit, so someone
    // who gives it no repository is not sent round in a circle.
    if (r.data.data.length === 0 && !installTried()) {
      markInstallTried()
      install()
    }
  }, [signed.access, write, install])

  React.useEffect(() => {
    void load()
    // Coming back from GitHub's install page: show what was just added.
    const again = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [load])

  const free = (repos ?? []).filter((r) => !r.linked && !results[r.slug]?.ok)
  const chosen = free.filter((r) => picked.has(r.slug))
  const chosenBytes = chosen.reduce((n, r) => n + r.size_bytes, 0)
  const room =
    plan && !plan.unlimited && plan.limits
      ? plan.limits.storageGb * 1e9 - plan.usage.storageBytes
      : null
  const tooBig = room !== null && chosenBytes > room
  const done = Object.values(results).some((r) => r?.ok) && !busy

  async function run() {
    if (!owner) return
    setBusy(true)
    for (const r of chosen) {
      const made = await write('imports.create', {
        body: {
          host: 'github',
          slug: r.slug,
          owner: owner.handle,
          github_access: signed.access,
          ...(r.private ? { visibility: 'private' as const } : {}),
        },
      })
      setResults((all) => ({
        ...all,
        [r.slug]: made.error
          ? { ok: false, text: made.error.message }
          : { ok: true, text: `${made.data.owner}/${made.data.name}` },
      }))
    }
    setPicked(new Set())
    setBusy(false)
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title="Bring your GitHub repositories">
        Signed in to GitHub as{' '}
        <span className="font-mono text-foreground">@{signed.login}</span>. Each
        repository you bring stays in sync with GitHub both ways. You can detach
        one from GitHub later in its settings.
      </PageTitle>

      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          {owners.length > 1 && owner ? (
            <label className="min-w-56 space-y-2 text-sm">
              <span className="font-medium">Bring them to</span>
              <Select value={owner.id} onValueChange={(v) => setOwnerId(v)}>
                {owners.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.kind === 'organization'
                      ? `${a.name} (organization)`
                      : `${a.name} (you)`}
                  </SelectItem>
                ))}
              </Select>
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void load()}
              aria-label="Refresh the list"
            >
              <ArrowPathIcon className="size-4" />
            </Button>
            <Button variant="outline" onClick={install}>
              Choose repositories on GitHub
              <ArrowTopRightOnSquareIcon className="size-4" />
            </Button>
          </div>
        </div>

        {error && (
          <Callout tone="danger" title="Could not list your repositories">
            {error}
          </Callout>
        )}

        {repos === null && !error ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : repos && repos.length === 0 ? (
          <div className="surface space-y-3 rounded-2xl border bg-card p-6 text-sm">
            <div className="flex items-center gap-3">
              <BrandLogo id="github" className="size-5" />
              <span className="font-medium">
                The Cobalt GitHub App is not on any repository yet
              </span>
            </div>
            <p className="text-muted-foreground">
              Open <b>Choose repositories on GitHub</b> and give the app all
              your repositories or just some. Then pick here which to bring.
            </p>
          </div>
        ) : (
          repos && (
            <ul className="surface divide-y overflow-hidden rounded-2xl border bg-card text-sm">
              {repos.map((r) => {
                const result = results[r.slug]
                const locked = !!r.linked || !!result?.ok || busy
                return (
                  <li key={r.slug}>
                    <label
                      className={cn(
                        'flex items-center gap-3 px-4 py-3',
                        !locked && 'cursor-pointer hover:bg-muted/40',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4"
                        disabled={locked}
                        checked={picked.has(r.slug) || !!result?.ok}
                        onChange={(e) =>
                          setPicked((all) => {
                            const next = new Set(all)
                            if (e.target.checked) next.add(r.slug)
                            else next.delete(r.slug)
                            return next
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {r.slug}
                      </span>
                      {r.private && (
                        <LockClosedIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-label="Private"
                        />
                      )}
                      <span
                        className={cn(
                          'shrink-0 text-xs tabular-nums',
                          result
                            ? result.ok
                              ? 'text-success'
                              : 'text-danger'
                            : 'text-muted-foreground',
                        )}
                      >
                        {result
                          ? result.ok
                            ? `Syncing as ${result.text}`
                            : result.text
                          : r.linked
                            ? `Already here as ${r.linked}`
                            : size(r.size_bytes)}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )
        )}

        {repos && repos.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p
              className={cn(
                'text-sm',
                tooBig ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              {chosen.length === 0
                ? 'Pick the repositories to bring.'
                : `${chosen.length} picked, ${size(chosenBytes)}`}
              {plan &&
                (plan.unlimited || !plan.limits
                  ? '. Your account has no storage limit.'
                  : `. ${size(Math.max(0, room ?? 0))} free on your ${plan.plan} plan.`)}
            </p>
            <div className="flex gap-2">
              {done && (
                <Button
                  variant="outline"
                  size="lg"
                  render={
                    signed.returnTo ? (
                      <a href={signed.returnTo} />
                    ) : (
                      <Link
                        to="/$handle"
                        params={{ handle: owner?.handle ?? '' }}
                        search={{ tab: 'repositories' }}
                      />
                    )
                  }
                  nativeButton={false}
                >
                  {signed.returnTo ? 'Continue' : 'See your repositories'}
                </Button>
              )}
              <Button
                variant="brand"
                size="lg"
                disabled={chosen.length === 0 || busy || tooBig || !owner}
                onClick={() => void run()}
              >
                {busy ? (
                  'Bringing them over'
                ) : (
                  <>
                    <CheckIcon className="size-4" />
                    {`Bring ${chosen.length || ''}`.trim()}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
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
  } catch {
    // Without storage the empty list stays, with its button.
  }
}

type Plan = {
  plan: string
  unlimited?: boolean
  limits: { storageGb: number } | null
  usage: { storageBytes: number }
}

function usePlan(): Plan | null {
  const raw = useQuery(api.plans.mine)
  return React.useMemo(() => {
    if (typeof raw !== 'string') return null
    try {
      return JSON.parse(raw) as Plan
    } catch {
      return null
    }
  }, [raw])
}
