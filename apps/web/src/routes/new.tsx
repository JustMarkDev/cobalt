import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useWrite } from '~/lib/forge'
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
          <Import owner={owner} />
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

type GithubRepo = {
  slug: string
  private: boolean
  default_branch: string
  linked: string | null
}

type SignIn =
  | { stage: 'idle' }
  | { stage: 'code'; userCode: string; uri: string }
  | { stage: 'ready'; access: string; login: string; at: number }

/** Signs in with GitHub on the device flow, then imports what is picked. */
function Import({ owner }: { owner: Owner }) {
  const write = useWrite()
  const [sign, setSign] = React.useState<SignIn>({ stage: 'idle' })
  const [repos, setRepos] = React.useState<Array<GithubRepo>>([])
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState('')
  const [results, setResults] = React.useState<
    Partial<Record<string, { ok: boolean; text: string }>>
  >({})
  const [busy, setBusy] = React.useState(false)
  const cancelled = React.useRef(false)
  React.useEffect(
    () => () => {
      cancelled.current = true
    },
    [],
  )

  async function signIn() {
    setError('')
    setBusy(true)
    const start = await write('github.device.start', {})
    if (start.error) {
      setBusy(false)
      setError(start.error.message)
      return
    }
    const d = start.data
    setSign({
      stage: 'code',
      userCode: d.user_code,
      uri: d.verification_uri,
    })
    let interval = d.interval * 1000
    const deadline = Date.now() + d.expires_in * 1000
    while (!cancelled.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval))
      const p = await write('github.device.poll', {
        body: { device_code: d.device_code },
      })
      if (p.error) {
        setError(p.error.message)
        break
      }
      const s = p.data
      if (s.status === 'slow_down') interval += 5000
      if (s.status === 'denied' || s.status === 'expired') {
        setError(
          s.status === 'denied'
            ? 'GitHub sign-in was denied.'
            : 'The code expired. Try again.',
        )
        break
      }
      if (s.status === 'authorized' && s.access && s.login) {
        const list = await write('github.repos.list', {
          body: { access: s.access },
        })
        if (list.error) setError(list.error.message)
        else {
          setRepos(list.data.data)
          setSign({
            stage: 'ready',
            access: s.access,
            login: s.login,
            at: Date.now(),
          })
        }
        break
      }
    }
    setBusy(false)
    setSign((now) => (now.stage === 'code' ? { stage: 'idle' } : now))
  }

  async function run() {
    if (sign.stage !== 'ready') return
    setBusy(true)
    setError('')
    for (const slug of picked) {
      const r = await write('imports.create', {
        body: {
          host: 'github',
          slug,
          owner: owner.handle,
          github_access: sign.access,
        },
      })
      setResults((all) => ({
        ...all,
        [slug]: r.error
          ? { ok: false, text: r.error.message }
          : { ok: true, text: `${r.data.owner}/${r.data.name}` },
      }))
    }
    setBusy(false)
  }

  const importable = repos.filter((r) => !r.linked)
  const done =
    picked.size > 0 && [...picked].every((t) => results[t]?.ok) && !busy

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <SectionLabel>Import from GitHub</SectionLabel>
        <p className="text-sm text-muted-foreground">
          The repository stays in sync with GitHub both ways: what you push here
          reaches GitHub, and what is pushed there reaches here. You sign in
          with GitHub so we can check you may push to it, and the Cobalt GitHub
          App must be installed on it.
        </p>
      </div>

      {sign.stage === 'idle' && (
        <Button
          variant="brand"
          size="lg"
          disabled={busy}
          onClick={() => void signIn()}
        >
          Sign in with GitHub
        </Button>
      )}

      {sign.stage === 'code' && (
        <div className="surface space-y-3 rounded-2xl border bg-card p-6 text-sm">
          <div>
            Open{' '}
            <a
              href={sign.uri}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline-offset-4 hover:underline"
            >
              {sign.uri}
            </a>{' '}
            and enter this code:
          </div>
          <CopyField value={sign.userCode} />
          <p className="text-xs text-muted-foreground">
            Waiting for you to approve it.
          </p>
        </div>
      )}

      {sign.stage === 'ready' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Signed in to GitHub as{' '}
            <span className="font-mono">{sign.login}</span>. Repositories where
            the app is installed and you may push:
          </p>
          {repos.length === 0 ? (
            <div className="surface space-y-2 rounded-2xl border bg-card p-6 text-sm">
              <div className="font-medium">No repositories yet</div>
              <p className="text-muted-foreground">
                Install the Cobalt GitHub App on the repositories you want to
                bring here, then sign in again.
              </p>
            </div>
          ) : (
            <ul className="surface divide-y overflow-hidden rounded-2xl border bg-card text-sm">
              {repos.map((r) => (
                <li key={r.slug} className="flex items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Import ${r.slug}`}
                    disabled={!!r.linked || busy}
                    checked={picked.has(r.slug)}
                    onChange={(e) =>
                      setPicked((all) => {
                        const next = new Set(all)
                        if (e.target.checked) next.add(r.slug)
                        else next.delete(r.slug)
                        return next
                      })
                    }
                  />
                  <span className="flex-1 font-mono">{r.slug}</span>
                  <span
                    className={cn(
                      'text-xs',
                      results[r.slug]
                        ? results[r.slug]?.ok
                          ? 'text-success'
                          : 'text-danger'
                        : 'text-muted-foreground',
                    )}
                  >
                    {results[r.slug]
                      ? results[r.slug]?.ok
                        ? `Imported as ${results[r.slug]?.text}, syncing`
                        : results[r.slug]?.text
                      : r.linked
                        ? `Already here as ${r.linked}`
                        : r.private
                          ? 'Private'
                          : 'Public'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {sign.stage === 'ready' && importable.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-3">
          {done ? (
            <Button
              variant="brand"
              size="lg"
              render={
                <Link
                  to="/$handle"
                  params={{ handle: owner.handle }}
                  search={{ tab: 'repositories' }}
                />
              }
              nativeButton={false}
            >
              View your repositories
            </Button>
          ) : (
            <Button
              variant="brand"
              size="lg"
              disabled={picked.size === 0 || busy}
              onClick={() => void run()}
            >
              {busy ? 'Importing' : `Import ${picked.size || ''}`.trim()}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
