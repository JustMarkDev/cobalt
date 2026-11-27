import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useWrite } from '~/lib/forge'
import { startGithubLink } from '~/lib/github-link'
import { startProviderLink } from '~/lib/provider-link'
import { liveProviders } from '~/components/forge/provider-picker'
import { CheckIcon } from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { RequireAuth } from '~/components/forge/auth'
import { PageTitle, SectionLabel } from '~/components/forge/bits'
import { CopyField } from '~/components/forge/repo-shell'
import { Toggle } from '~/components/forge/repo-pages'
import { Button } from '~/components/ui/button'
import { manages, useAccounts } from '~/lib/auth/accounts'
import { Segmented } from '~/components/ui/tabs'
import { Select, SelectItem } from '~/components/ui/select'
import { field } from '~/components/ui/input'

export const Route = createFileRoute('/new')({
  head: () => ({ meta: [{ title: 'New repository · cobalt' }] }),
  validateSearch: (
    s: Record<string, unknown>,
  ): { mode?: 'create' | 'import' } => ({
    mode:
      s.mode === 'import'
        ? 'import'
        : s.mode === 'create'
          ? 'create'
          : undefined,
  }),
  component: () => (
    <RequireAuth>
      <NewRepo />
    </RequireAuth>
  ),
})

function NewRepo() {
  const { mode = 'create' } = Route.useSearch()
  const { me, accounts, active } = useAccounts()
  const creatable = accounts.filter((a) => me && manages(a))
  const [picked, setPicked] = React.useState<string | null>(null)
  const owner =
    creatable.find((a) => a.id === picked) ??
    creatable.find((a) => a.id === active?.id) ??
    creatable.at(0)
  const picker = owner && (
    <label className="space-y-2 text-sm">
      <span className="font-medium">Owner</span>
      <Select value={owner.id} onValueChange={(v) => setPicked(v)}>
        {creatable.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.kind === 'organization'
              ? `${a.name} (organization)`
              : `${a.name} (you)`}
          </SelectItem>
        ))}
      </Select>
    </label>
  )
  const navigate = Route.useNavigate()
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title="New repository">
        Start something here, or bring a project and its history with you.
      </PageTitle>
      <div className="mb-6">
        <Segmented
          label="How to start"
          value={mode}
          onChange={(id) =>
            void navigate({ search: { mode: id }, replace: true })
          }
          options={[
            ['create', 'Create new'],
            ['import', 'Import existing'],
          ]}
        />
      </div>
      {owner &&
        (mode === 'create' ? (
          <Create owner={owner} picker={picker} />
        ) : (
          <Import />
        ))}
    </div>
  )
}

type Owner = { handle: string; name: string; kind: 'person' | 'organization' }

function Create({ owner, picker }: { owner: Owner; picker: React.ReactNode }) {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [isPrivate, setPrivate] = React.useState(false)
  const [created, setCreated] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const write = useWrite()
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)

  if (created) {
    return (
      <div className="surface space-y-4 rounded-2xl border bg-card p-6">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-success/15">
            <CheckIcon className="size-4 text-success" />
          </span>
          <div>
            <Link
              to="/$handle/$repo/$tab"
              params={{ handle: owner.handle, repo: created, tab: 'code' }}
              className="font-semibold hover:underline"
            >
              {owner.handle}/{created} is ready
            </Link>
            <div className="text-sm text-muted-foreground">
              {owner.kind === 'organization'
                ? `It belongs to ${owner.name}, not to you. Push your first commit to see it here.`
                : 'Push your first commit to see it here.'}
            </div>
          </div>
        </div>
        <CopyField
          value={`git remote add origin https://cobaltforge.dev/${owner.handle}/${created}.git`}
        />
        <CopyField value="git push -u origin main" />
        <Button
          variant="outline"
          onClick={() => {
            setCreated(null)
            setName('')
            setDescription('')
          }}
        >
          Create another
        </Button>
      </div>
    )
  }
  return (
    <form
      className="surface space-y-6 rounded-2xl border bg-card p-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        setError('')
        void write('repos.create', {
          body: {
            name,
            owner: owner.handle,
            description: description || undefined,
            visibility: isPrivate ? 'private' : 'public',
          },
        }).then((r) => {
          setBusy(false)
          if (r.error) setError(r.error.message)
          else setCreated(r.data.name)
        })
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr]">
        {picker}
        <label className="space-y-2 text-sm">
          <span className="font-medium">Repository name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={name !== '' && !valid}
            className={cn(field, 'h-9 font-mono')}
          />
          <span
            className={cn(
              'block text-xs',
              name && !valid ? 'text-danger' : 'text-muted-foreground',
            )}
          >
            {name && !valid
              ? 'Start with a letter or number; then letters, numbers, dots, dashes and underscores.'
              : 'Short and memorable works best.'}
          </span>
        </label>
      </div>
      <label className="block space-y-2 text-sm">
        <span className="font-medium">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          className={cn(field, 'h-9')}
        />
      </label>
      <Toggle
        checked={isPrivate}
        onChange={setPrivate}
        label="Private"
        hint="Only you and the people you add can see it."
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end">
        <Button
          variant="brand"
          size="lg"
          type="submit"
          disabled={!valid || busy}
        >
          Create repository
        </Button>
      </div>
    </form>
  )
}

function Import() {
  const write = useWrite()
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const go = (host: 'github' | 'gitlab' | 'codeberg') => {
    setBusy(host)
    setError('')
    const started =
      host === 'github'
        ? startGithubLink(write, '/new?mode=import')
        : startProviderLink(write, host, '/new?mode=import')
    void started.then((e) => {
      if (e) {
        setError(e)
        setBusy(null)
      }
    })
  }
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <SectionLabel>Import from GitHub</SectionLabel>
        <p className="text-sm text-muted-foreground">
          Sign in, then pick which repositories to bring here. Each one stays in
          sync with its host both ways, its pull requests, issues and releases
          come along as changes, issues and releases here, and you can detach it
          later in its settings. On GitHub, choose the repositories the Cobalt
          GitHub App may see.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['github', 'GitHub'],
            ['gitlab', 'GitLab'],
            ['codeberg', 'Codeberg'],
          ] as const
        ).map(([host, name]) =>
          liveProviders.has(host) ? (
            <Button
              key={host}
              variant={host === 'github' ? 'brand' : 'outline'}
              size="lg"
              disabled={busy !== null}
              onClick={() => go(host)}
            >
              {busy === host ? `Opening ${name}` : `Continue with ${name}`}
            </Button>
          ) : (
            <Button
              key={host}
              variant="outline"
              size="lg"
              disabled
              title={`${name} is planned. Not available yet.`}
            >
              {name} · Planned
            </Button>
          ),
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
