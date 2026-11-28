import * as React from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { Dialog } from '@base-ui/react/dialog'
import {
  BellIcon,
  CpuIcon,
  CreditCardIcon,
  DownloadSimpleIcon,
  HardDrivesIcon,
  LinkIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { cn } from 'cn'
import type { AuthUser } from '~/lib/auth/client'
import { RequireAuth } from '~/components/forge/auth'
import { useOp, useOpMaybe, useWrite } from '~/lib/forge'
import { useMe } from '~/lib/auth/accounts'
import { Input, field, fieldShell } from '~/components/ui/input'
import { Chip, SectionLabel, SourceBadge } from '~/components/forge/bits'
import { BrandLogo } from '~/components/brand'
import { TargetPicker } from '~/components/forge/download-button'
import { MachinesPanel } from '~/components/forge/machines-panel'
import { RunnersPanel } from '~/components/forge/runners-panel'
import { PlanAndData } from '~/components/forge/account-data'
import { IntegrationsPanel } from '~/components/forge/integrations-panel'
import { Toggle } from '~/components/forge/repo-pages'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { authClient } from '~/lib/auth/client'
import { startGithubLink } from '~/lib/github-link'
import { startProviderLink } from '~/lib/provider-link'
import { liveProviders } from '~/components/forge/provider-picker'

const sections = [
  ['profile', 'Profile', UserIcon],
  ['accounts', 'Linked accounts', LinkIcon],
  ['integrations', 'Integrations', PuzzlePieceIcon],
  ['agents', 'Machines and tokens', CpuIcon],
  ['runners', 'Runners', HardDrivesIcon],
  ['privacy', 'Privacy', ShieldCheckIcon],
  ['downloads', 'Downloads', DownloadSimpleIcon],
  ['notifications', 'Notifications', BellIcon],
  ['plan', 'Plan and data', CreditCardIcon],
] as const

type SectionId = (typeof sections)[number][0]

export const Route = createFileRoute('/settings/$section')({
  head: () => ({ meta: [{ title: 'Settings · cobalt' }] }),
  component: () => (
    <RequireAuth>
      <Settings />
    </RequireAuth>
  ),
})

function Settings() {
  const { section } = Route.useParams()
  const current = sections.find(([id]) => id === section)?.[0]
  if (!current) throw notFound()
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav
        aria-label="Settings"
        className="flex gap-1 overflow-x-auto lg:sticky lg:top-header lg:flex-col lg:self-start"
      >
        {sections.map(([id, label, Icon]) => (
          <Link
            key={id}
            to="/settings/$section"
            params={{ section: id }}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors focus-ring-inset hover:bg-muted hover:text-foreground',
              id === current && 'bg-muted font-medium text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        {current === 'profile' && <ProfileSettings />}
        {current === 'accounts' && <Accounts />}
        {current === 'integrations' && (
          <div className="max-w-3xl">
            <Header id="integrations" title="Integrations">
              Connect a service once. Then turn it on for the repositories that
              should use it, from each repository&apos;s settings.
            </Header>
            <IntegrationsPanel />
          </div>
        )}
        {current === 'agents' && (
          <div className="max-w-4xl">
            <Header id="agents" title="Machines and tokens">
              Everything that can act as you. Agents use the login of the
              machine they run on.
            </Header>
            <MachinesPanel />
          </div>
        )}
        {current === 'runners' && (
          <div className="max-w-4xl">
            <Header id="runners" title="Runners">
              Machines that run your pipeline jobs: a Mac mini under a desk, a
              Linux build server, or a hosted provider. cobalt routes each job
              to a runner whose labels cover its <code>runs-on</code>; the
              machine runs it.
            </Header>
            <RunnersPanel />
          </div>
        )}
        {current === 'privacy' && <Privacy />}
        {current === 'downloads' && <Downloads />}
        {current === 'notifications' && <Notifications />}
        {current === 'plan' && (
          <>
            <Header id="plan" title="Plan and data">
              What your account is on, a copy of your data, and deleting the
              account.
            </Header>
            <PlanAndData />
          </>
        )}
      </div>
    </div>
  )
}

function Header({
  id,
  title,
  children,
}: {
  id: SectionId
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-6" data-section={id}>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children && (
        <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  )
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'space-y-4 surface rounded-2xl border bg-card p-5',
        className,
      )}
    >
      {children}
    </section>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="block text-xs text-danger">
          {error}
        </span>
      ) : (
        hint && (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )
      )}
    </label>
  )
}

const input = cn(field, 'h-9 disabled:opacity-60')

function ProfileSettings() {
  const { data: session } = authClient.useSession()
  const handle = session?.user.handle ?? ''
  const account = useOpMaybe('accounts.get', { handle }, !!handle)
  if (!session || account === undefined) return null
  return (
    <ProfileForm key={handle} user={session.user} bio={account?.bio ?? ''} />
  )
}

type Problem = { field: 'name' | 'email' | 'handle' | 'bio'; message: string }
const problemField: Record<string, Problem['field']> = {
  INVALID_NAME: 'name',
  INVALID_EMAIL: 'email',
  INVALID_ADDRESS: 'handle',
  ADDRESS_TAKEN: 'handle',
}

function ProfileForm({ user, bio: savedBio }: { user: AuthUser; bio: string }) {
  const write = useWrite()
  const [saved, setSaved] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [name, setName] = React.useState(user.name)
  const [email, setEmail] = React.useState(user.email)
  const [address, setAddress] = React.useState(user.handle)
  const [bio, setBio] = React.useState(savedBio)
  const [problem, setProblem] = React.useState<Problem | null>(null)
  const emailChanged = email.trim().toLowerCase() !== user.email

  const save = async () => {
    setSaving(true)
    setProblem(null)
    const { data, error } = await authClient.updateUser({
      name,
      email,
      handle: address,
    })
    if (error) {
      setSaving(false)
      setProblem({
        field: problemField[error.code] ?? 'name',
        message: error.message,
      })
      return
    }
    if (bio.trim() !== savedBio) {
      const r = await write('accounts.update', {
        handle: data?.user.handle ?? address,
        body: { bio: bio.trim() },
      })
      if (r.error) {
        setSaving(false)
        setProblem({ field: 'bio', message: r.error.message })
        return
      }
    }
    setSaving(false)
    setSaved(true)
  }
  const touch = () => setSaved(false)
  const errorOf = (f: Problem['field']) =>
    problem?.field === f ? problem.message : null
  return (
    <div className="max-w-2xl">
      <Header id="profile" title="Profile">
        What people see when they open your page.
      </Header>
      <div className="space-y-6">
        <Card>
          <Field label="Full name" error={errorOf('name')}>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                touch()
              }}
              autoComplete="name"
              className={input}
            />
          </Field>
          <Field
            label="Email"
            hint={
              emailChanged
                ? 'We will send a link to the new address. It changes once you open it.'
                : undefined
            }
            error={errorOf('email')}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                touch()
              }}
              autoComplete="email"
              className={input}
            />
          </Field>
          <Field label="Address" error={errorOf('handle')}>
            <span
              className={cn(
                fieldShell,
                'flex h-9 items-center overflow-hidden font-mono text-sm focus-within:border-foreground/40',
                errorOf('handle') && 'border-danger',
              )}
            >
              <span
                aria-hidden
                className="shrink-0 border-r bg-muted/50 px-3 self-stretch flex items-center text-muted-foreground select-none"
              >
                cobaltforge.dev/
              </span>
              <input
                value={address}
                onChange={(e) => {
                  setAddress(
                    e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                  )
                  touch()
                }}
                autoCapitalize="none"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent px-3 text-foreground outline-none"
              />
            </span>
          </Field>
          <Field label="Bio" error={errorOf('bio')}>
            <textarea
              value={bio}
              maxLength={300}
              rows={2}
              onChange={(e) => {
                setBio(e.target.value)
                touch()
              }}
              className={cn(field, 'block resize-none py-2')}
            />
          </Field>
        </Card>
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-success">Saved</span>}
          <Button
            variant="brand"
            size="lg"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving' : 'Save profile'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const hosts = [
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'Commits, pull requests, reviews, issues and releases.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    blurb: 'Commits, merge requests, issues and pipelines.',
  },
  {
    id: 'codeberg',
    name: 'Codeberg',
    blurb: 'Commits, pull requests and issues.',
  },
  {
    id: 'gitea',
    name: 'Gitea',
    blurb: 'Your own Gitea or Forgejo server.',
  },
] as const

function Accounts() {
  const me = useMe()
  const handle = me?.handle ?? ''
  const links = useOpMaybe('links.list', { handle }, !!me)?.data ?? []
  const imports = useOpMaybe('imports.list', {}, !!me)?.data ?? []
  const connections = useOpMaybe('providers.list', {}, !!me)?.data ?? []
  const audit = useOpMaybe('providers.audit', {}, !!me)?.data ?? []
  const session = authClient.useSession().data
  const write = useWrite()
  const [dialog, setDialog] = React.useState<(typeof hosts)[number] | null>(
    null,
  )
  const [login, setLogin] = React.useState('')
  const [instance, setInstance] = React.useState('')
  const [error, setError] = React.useState('')
  const [confirm, setConfirm] = React.useState<string | null>(null)
  const [sent, setSent] = React.useState(false)
  const instanceOk = /^https:\/\/[^\s/]+\.[^\s/]+/.test(instance)
  const close = () => {
    setDialog(null)
    setLogin('')
    setInstance('')
    setError('')
  }

  return (
    <div className="max-w-3xl">
      <Header id="accounts" title="Linked accounts">
        Say who you are on other hosts, and bring projects from them. Where a
        project came from stays private.
      </Header>

      <Card className="mb-6">
        <div className="font-mono text-4xl font-semibold tracking-tighter tabular-nums">
          {links.length}
        </div>
        <div className="text-sm text-muted-foreground">
          linked {links.length === 1 ? 'account' : 'accounts'}. Contributions
          from other hosts are counted once cobalt can sign in with them.
        </div>
      </Card>

      <div className="space-y-3">
        {hosts.map((p) => {
          const mine = links.filter((l) => l.host === p.id)
          const linkGithub = () =>
            void startGithubLink(write, '/settings/accounts').then(
              (e) => e && setError(e),
            )
          return (
            <section
              key={p.id}
              className="surface rounded-2xl border bg-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card">
                    <BrandLogo id={p.id} />
                  </span>
                  <div>
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {p.blurb}
                    </div>
                  </div>
                </div>
                {p.id === 'github' ? (
                  <Button
                    variant={mine.length ? 'outline' : 'default'}
                    onClick={linkGithub}
                  >
                    {mine.length ? 'Link another' : 'Link'}
                  </Button>
                ) : mine.length ? null : (p.id === 'gitlab' ||
                    p.id === 'codeberg') &&
                  liveProviders.has(p.id) ? (
                  <ProviderControls
                    provider={p.id}
                    name={p.name}
                    connection={connections.find((c) => c.provider === p.id)}
                    onError={setError}
                  />
                ) : (
                  <Badge>Planned</Badge>
                )}
              </div>
              {mine.map((link) => {
                const key = `${p.id}:${link.login}`
                return (
                  <div
                    key={key}
                    className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <b className="font-mono">@{link.login}</b>
                      {link.instance && (
                        <span className="text-muted-foreground">
                          on {link.instance}
                        </span>
                      )}
                      {link.verified ? (
                        <Chip tone="success">Verified</Chip>
                      ) : (
                        <Chip tone="warning">Not verified</Chip>
                      )}
                    </span>
                    {confirm === key ? (
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                          Unlink @{link.login}?
                        </span>
                        <Button
                          variant="danger"
                          onClick={() =>
                            void write('links.remove', {
                              handle,
                              host: p.id,
                              login: link.login,
                            }).then(() => setConfirm(null))
                          }
                        >
                          Unlink
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setConfirm(null)}
                        >
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => setConfirm(key)}
                      >
                        Unlink
                      </Button>
                    )}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>

      <Card className="mt-6">
        <SectionLabel>Email</SectionLabel>
        <p className="text-sm text-muted-foreground">
          Commits written with it are credited to you. One address per account
          for now.
        </p>
        {session && (
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
            <span className="font-mono text-xs">{session.user.email}</span>
            {session.user.emailVerified ? (
              <Chip tone="success">Verified</Chip>
            ) : sent ? (
              <Chip tone="warning">Link sent</Chip>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void authClient
                    .sendVerification(session.user.email)
                    .then((r) =>
                      r.error ? setError(r.error.message) : setSent(true),
                    )
                }
              >
                Verify it
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <div className="flex items-start justify-between gap-4">
          <SectionLabel>Imported projects</SectionLabel>
          <Chip>Only visible to you</Chip>
        </div>
        <ul className="divide-y overflow-hidden rounded-xl border">
          {imports.map((i) => (
            <li
              key={i.repo}
              className="flex items-center gap-3 px-3 py-2.5 text-sm"
            >
              <span className="flex-1 font-mono">{i.repo}</span>
              <SourceBadge source={i.host} />
              <span
                className="w-32 text-right text-xs text-muted-foreground"
                title={i.warnings.join('\n\n')}
              >
                {i.state === 'in-sync' ? 'In sync' : i.state}
              </span>
            </li>
          ))}
          {imports.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">
              Nothing imported yet.
            </li>
          )}
        </ul>
        <Link
          to="/new"
          search={{ mode: 'import' }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Import projects
        </Link>
      </Card>

      {audit.length > 0 && (
        <Card className="mt-6">
          <SectionLabel>Recent activity with providers</SectionLabel>
          <ul className="divide-y overflow-hidden rounded-xl border text-sm">
            {audit.slice(0, 12).map((a, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2">
                <SourceBadge source={a.provider} />
                <span className="flex-1">
                  {auditText[a.action]}
                  {a.repo && <span className="font-mono"> {a.repo}</span>}
                  {a.detail && (
                    <span className="text-muted-foreground"> · {a.detail}</span>
                  )}
                </span>
                <time className="text-xs text-muted-foreground">
                  {new Date(a.at).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog.Root open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <Dialog.Portal>
          <Dialog.Backdrop className="overlay-backdrop fixed inset-0 z-50 bg-background/80" />
          <Dialog.Popup className="overlay-popup fixed top-[18vh] left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 space-y-4 rounded-2xl border bg-popover p-6 floating outline-none">
            {dialog && (
              <>
                <Dialog.Title className="text-lg font-semibold tracking-tight">
                  Link {dialog.name}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Say who you are there. Until cobalt can sign in with{' '}
                  {dialog.name}, it is shown as not verified.
                </Dialog.Description>
                <Field label={`Your ${dialog.name} username`}>
                  <Input
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                {dialog.id === 'gitea' && (
                  <Field label="Server address">
                    <Input
                      value={instance}
                      onChange={(e) => setInstance(e.target.value)}
                      placeholder="https://git.example.com"
                      className="font-mono"
                    />
                  </Field>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                  <Button
                    variant="brand"
                    size="lg"
                    disabled={
                      !login.trim() || (dialog.id === 'gitea' && !instanceOk)
                    }
                    onClick={() =>
                      void write('links.set', {
                        handle,
                        host: dialog.id,
                        body: {
                          login: login.trim(),
                          ...(dialog.id === 'gitea' ? { instance } : {}),
                        },
                      }).then((r) =>
                        r.error ? setError(r.error.message) : close(),
                      )
                    }
                  >
                    Link
                  </Button>
                </div>
              </>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

const auditText = {
  connected: 'Connected',
  reconnected: 'Connected again',
  disconnected: 'Disconnected',
  imported: 'Imported',
  adopted: 'Took over the link of',
  unlinked: 'Unlinked',
  relinked: 'Followed a rename of',
  published: 'Published to GitHub',
  needs_reconnect: 'The provider refused the token',
} as const

function ProviderControls({
  provider,
  name,
  connection,
  onError,
}: {
  provider: 'gitlab' | 'codeberg'
  name: string
  connection:
    | {
        login: string
        state: 'ok' | 'needs_reconnect'
        repos: number
        problem: string | null
      }
    | undefined
  onError: (e: string) => void
}) {
  const write = useWrite()
  const [confirm, setConfirm] = React.useState(false)
  const connect = () =>
    void startProviderLink(write, provider, '/settings/accounts').then(
      (e) => e && onError(e),
    )
  if (!connection) return <Button onClick={connect}>Connect</Button>
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono">{connection.login}</span>
      {connection.state === 'ok' ? (
        <Chip tone="success">
          {connection.repos === 1
            ? '1 repository syncs through it'
            : `${connection.repos} repositories sync through it`}
        </Chip>
      ) : (
        <span title={connection.problem ?? undefined}>
          <Chip tone="warning">Needs reconnecting</Chip>
        </span>
      )}
      <Button variant="outline" size="sm" onClick={connect}>
        {connection.state === 'ok' ? 'Bring repositories' : 'Reconnect'}
      </Button>
      {confirm ? (
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">
            Unlinks {connection.repos} from {name}; their history here stays.
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={() =>
              void write('providers.disconnect', { provider }).then((r) => {
                if (r.error) onError(r.error.message)
                setConfirm(false)
              })
            }
          >
            Disconnect
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setConfirm(true)}
        >
          Disconnect
        </Button>
      )}
    </div>
  )
}

function Privacy() {
  const prefs = useOp('preferences.get', {})
  const write = useWrite()
  const [error, setError] = React.useState('')
  const state = {
    combined: prefs.combined_total,
    privateTotals: prefs.private_totals,
    searchable: prefs.searchable,
    activity: prefs.show_activity,
    agents: prefs.show_agents,
  }
  const column = {
    combined: 'combined_total',
    privateTotals: 'private_totals',
    searchable: 'searchable',
    activity: 'show_activity',
    agents: 'show_agents',
  } as const
  const set = (k: keyof typeof state) => (v: boolean) =>
    void write('preferences.update', { body: { [column[k]]: v } }).then((r) =>
      setError(r.error?.message ?? ''),
    )
  return (
    <div className="max-w-2xl">
      <Header id="privacy" title="Privacy">
        You decide what your profile shows. Linked accounts stay linked quietly.
        How we handle your data is in the{' '}
        <Link
          to="/privacy"
          className="underline decoration-border underline-offset-4 hover:text-foreground"
        >
          privacy policy
        </Link>
        .
      </Header>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="space-y-6">
        <Card>
          <Toggle
            label="Show one combined contribution total"
            hint="Merges everything you linked into a single number and graph."
            checked={state.combined}
            onChange={set('combined')}
          />
          <Toggle
            label="Include private contribution totals"
            hint="Counts only. Titles and repositories are never exposed."
            checked={state.privateTotals}
            onChange={set('privateTotals')}
          />
          <Toggle
            label="Show recent activity"
            hint="Pushes, releases and reviews on public projects."
            checked={state.activity}
            onChange={set('activity')}
          />
          <Toggle
            label="Show how I work with agents"
            hint="The share of recent commits that were agent-assisted, and which agents. Only counts changes a person reviewed."
            checked={state.agents}
            onChange={set('agents')}
          />
          <Toggle
            label="Let people find me by name"
            hint="Appears in search and on the People tab of Discover."
            checked={state.searchable}
            onChange={set('searchable')}
          />
        </Card>
        <Card>
          <SectionLabel>Where projects came from</SectionLabel>
          <fieldset className="space-y-2 text-sm">
            {(
              [
                ['me', 'Only me', true],
                ['team', 'People I invite to a project', false],
                ['public', 'Everyone', false],
              ] as const
            ).map(([id, label, on]) => (
              <label
                key={id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3',
                  !on && 'opacity-50',
                )}
              >
                <input
                  type="radio"
                  name="origin"
                  checked={on}
                  disabled={!on}
                  readOnly
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            cobalt is its own home for your work, so imported projects look like
            any other project. Their origin is never shown on Discover or on a
            project page.
          </p>
        </Card>
        <Card>
          <SectionLabel>Your data</SectionLabel>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline">Export everything</Button>
            <Button variant="danger">Delete account</Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function Downloads() {
  return (
    <div className="max-w-2xl">
      <Header id="downloads" title="Downloads">
        The theme follows your device, so there is nothing to set for it.
      </Header>
      <Card>
        <p className="text-sm text-muted-foreground">
          Every download button picks the file for the machine you are on, down
          to the CPU. If we guess wrong, correct it here and we will remember.
        </p>
        <TargetPicker />
      </Card>
    </div>
  )
}

function Notifications() {
  const s = useOp('notifications.preferences', {})
  const write = useWrite()
  const [error, setError] = React.useState('')
  const set = (k: Exclude<keyof typeof s, 'object'>) => (v: boolean) =>
    void write('notifications.update_preferences', { body: { [k]: v } }).then(
      (r) => setError(r.error?.message ?? ''),
    )
  return (
    <div className="max-w-2xl">
      <Header id="notifications" title="Notifications">
        Choose what reaches your inbox and your email.
      </Header>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <Card>
        <Toggle
          label="Pipeline steps waiting on you"
          checked={s.handoff}
          onChange={set('handoff')}
        />
        <Toggle
          label="Review requests"
          checked={s.review}
          onChange={set('review')}
        />
        <Toggle
          label="Mentions"
          checked={s.mention}
          onChange={set('mention')}
        />
        <Toggle
          label="New releases from projects you follow"
          checked={s.release}
          onChange={set('release')}
        />
        <Toggle
          label="Failed builds on your projects"
          checked={s.ci}
          onChange={set('ci')}
        />
        <Toggle
          label="Issues assigned to you"
          checked={s.issue}
          onChange={set('issue')}
        />
        <Toggle
          label="Finished imports and syncs"
          checked={s.import}
          onChange={set('import')}
        />
        <Toggle
          label="Weekly digest by email"
          hint="One email on Mondays with what changed. Saved now; the email starts when sending does."
          checked={s.digest}
          onChange={set('digest')}
        />
      </Card>
    </div>
  )
}
