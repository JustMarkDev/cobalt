import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { IntegrationsPanel } from './integrations-panel'
import { PoliciesPage } from './repo-policies'
import { AccessPage } from './repo-access'
import { AutomationsPage, RepoRunnersPage } from './repo-automations'
import { SecretsPage } from './repo-secrets'
import { slugOf } from './repo-shell'
import type { Host, Mirror } from '~/lib/model/hub'
import type { Repo } from '~/lib/model/data'
import { BrandLogo } from '~/components/brand'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, Input, Textarea, field } from '~/components/ui/input'
import { Modal } from '~/components/ui/dialog'
import { SwitchRow } from '~/components/ui/switch'
import { Select, SelectItem } from '~/components/ui/select'
import { hostNames } from '~/lib/model/hub'
import { useOp, useOpMaybe, useWrite } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

const sections = [
  ['general', 'General'],
  ['mirrors', 'Mirrors and sync'],
  ['secrets', 'Secrets'],
  ['access', 'Access'],
  ['policies', 'Policies'],
  ['automations', 'Automations'],
  ['runners', 'Runners'],
  ['contributions', 'Contributions'],
  ['integrations', 'Integrations'],
] as const

type Section = (typeof sections)[number][0]

function Title({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-6 space-y-1">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children && (
        <p className="max-w-[60ch] text-sm text-muted-foreground">{children}</p>
      )}
    </div>
  )
}

function General({ repo }: { repo: Repo }) {
  const at = { owner: repo.owner, repo: repo.name }
  const write = useWrite()
  const navigate = useNavigate()
  const [description, setDescription] = React.useState(repo.description)
  const [install, setInstall] = React.useState(repo.install ?? '')
  const [visibility, setVisibility] = React.useState<'public' | 'private'>(
    repo.visibility ?? 'public',
  )
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [deleting, setDeleting] = React.useState(false)
  const [transferring, setTransferring] = React.useState(false)
  const full = `${repo.owner}/${repo.name}`
  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-5">
        <Field label="Description">
          <Textarea
            value={description}
            rows={2}
            onChange={(e) => {
              setDescription(e.target.value)
              setSaved(false)
            }}
          />
        </Field>
        <Field
          label="Install commands"
          hint="One per line, such as brew install you/tap/app. Left empty, the commands in the README are shown, if it has any."
        >
          <Textarea
            value={install}
            rows={3}
            className="font-mono text-sm"
            placeholder="winget install You.App"
            onChange={(e) => {
              setInstall(e.target.value)
              setSaved(false)
            }}
          />
        </Field>
        <Field label="Visibility">
          <Select
            value={visibility}
            onValueChange={(v) => {
              setVisibility(v === 'private' ? 'private' : 'public')
              setSaved(false)
            }}
          >
            <SelectItem value="public">
              Public: anyone can find it and download releases
            </SelectItem>
            <SelectItem value="private">
              Private: only people you invite
            </SelectItem>
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <Button
            variant="brand"
            onClick={() =>
              void write('repos.update', {
                ...at,
                body: {
                  description,
                  visibility,
                  install: install.trim() === '' ? null : install.trim(),
                },
              }).then((r) => {
                setError(r.error?.message ?? '')
                setSaved(!r.error)
              })
            }
          >
            Save changes
          </Button>
          {saved && <span className="text-sm text-success">Saved</span>}
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
      </div>
      <div className="space-y-3 border-t pt-6">
        <h3 className="text-sm font-medium text-danger">Danger zone</h3>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            Give this project to another account you manage, or delete it.
          </span>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setTransferring(true)
                setDeleting(false)
                setConfirm('')
              }}
            >
              Transfer
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(true)
                setTransferring(false)
                setConfirm('')
              }}
            >
              Delete
            </Button>
          </div>
        </div>
        {transferring && (
          <Transfer
            repo={repo}
            onCancel={() => setTransferring(false)}
            onError={setError}
          />
        )}
        {deleting && (
          <div className="space-y-2 rounded-xl border border-danger/40 p-3 text-sm">
            <p>
              Type <span className="font-mono">{full}</span> to delete it, its
              issues, changes and releases.
            </p>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-label="Repository name"
              className={cn(field, 'h-9 font-mono')}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={confirm !== full}
                onClick={() =>
                  void write('repos.delete', { ...at, confirm: full }).then(
                    (r) => {
                      if (r.error) return setError(r.error.message)
                      void navigate({ to: '/dashboard' })
                    },
                  )
                }
              >
                Delete for good
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Transfer({
  repo,
  onCancel,
  onError,
}: {
  repo: Repo
  onCancel: () => void
  onError: (message: string) => void
}) {
  const write = useWrite()
  const navigate = useNavigate()
  const full = `${repo.owner}/${repo.name}`
  const places = useOp('accounts.list', {}).data.filter(
    (a) =>
      a.handle !== repo.owner && (a.role === 'owner' || a.role === 'admin'),
  )
  const [to, setTo] = React.useState(places[0]?.handle ?? '')
  const [confirm, setConfirm] = React.useState('')
  if (!places.length)
    return (
      <p className="rounded-xl border p-3 text-sm text-muted-foreground">
        You do not own or administer another account to move it to. Create an
        organization first.
      </p>
    )
  return (
    <div className="space-y-3 rounded-xl border p-3 text-sm">
      <Field label="Move it to">
        <Select value={to} onValueChange={(v) => setTo(String(v))}>
          {places.map((a) => (
            <SelectItem key={a.handle} value={a.handle}>
              {a.name} ({a.handle})
            </SelectItem>
          ))}
        </Select>
      </Field>
      <p>
        Its old address will send people to{' '}
        <span className="font-mono">
          {to}/{repo.name}
        </span>
        . Teams of {repo.owner} lose their access. Type{' '}
        <span className="font-mono">{full}</span> to go ahead.
      </p>
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        aria-label="Repository name to transfer"
        className={cn(field, 'h-9 font-mono')}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="brand"
          disabled={confirm !== full || !to}
          onClick={() =>
            void write('repos.transfer', {
              owner: repo.owner,
              repo: repo.name,
              body: { owner: to, confirm: full },
            }).then((r) => {
              if (r.error) return onError(r.error.message)
              void navigate({
                to: '/$handle/$repo/$tab',
                params: {
                  handle: r.data.owner,
                  repo: r.data.name,
                  tab: 'settings',
                },
              })
            })
          }
        >
          Transfer to {to}
        </Button>
      </div>
    </div>
  )
}

const stateTone = {
  'in-sync': 'success',
  syncing: 'info',
  behind: 'warning',
  failing: 'danger',
} as const
const stateLabel = {
  'in-sync': 'In sync',
  syncing: 'Syncing',
  behind: 'Behind',
  failing: 'Needs attention',
} as const
const directionLabel = {
  'two-way': 'Two-way',
  push: 'Push to host',
  pull: 'Pull from host',
} as const

function MirrorRow({
  m,
  paused,
  onSync,
  onPause,
  onRemove,
}: {
  m: Mirror
  paused: boolean
  onSync: () => Promise<void>
  onPause: (paused: boolean) => void
  onRemove: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const carried = (
    [
      ['issues', 'Issues'],
      ['changes', 'Pull requests'],
      ['releases', 'Releases'],
      ['wiki', 'Wiki'],
    ] as const
  ).filter(([k]) => m.carries[k])
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg border bg-card">
          <BrandLogo id={m.host} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {hostNames[m.host]}
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {m.slug}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {directionLabel[m.direction]} · last synced {m.last}
          </p>
        </div>
        {paused ? (
          <Badge tone="warning">Paused</Badge>
        ) : (
          <Badge tone={stateTone[m.state]}>
            {m.state === 'in-sync' && <CheckCircleIcon />}
            {m.state === 'failing' && <ExclamationTriangleIcon />}
            {stateLabel[m.state]}
          </Badge>
        )}
        <Button size="sm" variant="ghost" onClick={() => onPause(!paused)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          size="sm"
          disabled={busy || paused}
          onClick={() => {
            setBusy(true)
            void onSync().finally(() => setBusy(false))
          }}
        >
          <ArrowPathIcon className={cn(busy && 'animate-spin')} />
          {m.state === 'failing' ? 'Reconnect' : 'Sync now'}
        </Button>
      </div>
      {m.detail && (
        <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {m.detail}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>
          Carries:{' '}
          <span className="text-foreground">
            Git history
            {carried.map(([, l]) => `, ${l.toLowerCase()}`).join('')}
          </span>
        </span>
        <button
          type="button"
          className="-my-1 rounded-sm px-2 py-1.5 hover:bg-danger/10 hover:text-danger"
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </li>
  )
}

function AddMirror({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  onAdd: (m: Mirror) => void
}) {
  const [host, setHost] = React.useState<Host>('github')
  const [slug, setSlug] = React.useState('')
  const [direction, setDirection] = React.useState<Mirror['direction']>('push')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a mirror"
      description="cobalt stays the primary. The mirror keeps a copy on another host."
    >
      <div className="space-y-4">
        <Field label="Host">
          <Select value={host} onValueChange={(v) => setHost(v as Host)}>
            {(Object.keys(hostNames) as Array<Host>).map((h) => (
              <SelectItem key={h} value={h}>
                {hostNames[h]}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label="Repository on that host" hint="owner/name">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="dana/gitfs"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Direction">
          <Select
            value={direction}
            onValueChange={(v) => setDirection(v as Mirror['direction'])}
          >
            <SelectItem value="push">Push: send everything there</SelectItem>
            <SelectItem value="two-way">
              Two-way: also bring back issues and pull requests
            </SelectItem>
            <SelectItem value="pull">
              Pull: only receive from that host
            </SelectItem>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            disabled={!slug.includes('/')}
            onClick={() => {
              onAdd({
                id: `m${Date.now()}`,
                host,
                slug,
                direction,
                state: 'syncing',
                last: 'just now',
                carries: {
                  issues: direction === 'two-way',
                  changes: direction === 'two-way',
                  releases: true,
                  wiki: false,
                },
              })
              onClose()
              setSlug('')
            }}
          >
            Add mirror
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const linkState = {
  syncing: 'First sync running',
  linked: 'In sync both ways',
  delayed: 'Changes there arrive late',
  broken: 'Not syncing',
  archived: 'Archived there',
  gone: 'Deleted there',
} as const

function ProviderLinkCard({ at }: { at: { owner: string; repo: string } }) {
  const link = useOpMaybe('repos.provider.get', at)
  const write = useWrite()
  const [note, setNote] = React.useState('')
  if (!link) return null
  const name = hostNames[link.provider as Host]
  return (
    <section className="surface space-y-3 rounded-2xl border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrandLogo id={link.provider} className="size-5" />
          <div>
            <a
              href={link.url}
              className="font-mono font-medium hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {link.slug}
            </a>
            <div className="text-xs text-muted-foreground">
              {linkState[link.state]}
              {link.last_sync_at && ` · synced ${timeAgo(link.last_sync_at)}`}
              {link.connection
                ? ` · through ${link.connection.handle}'s ${name} account (${link.connection.login})`
                : link.provider === 'github'
                  ? ' · through the Cobalt GitHub App'
                  : ''}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void write('repos.provider.refresh', at).then((r) =>
                setNote(
                  r.error
                    ? r.error.message
                    : `Pull requests, issues and releases will be read from ${name} again shortly.`,
                ),
              )
            }
          >
            Read items again
          </Button>
          {link.adoptable && (
            <Button
              size="sm"
              variant="brand"
              onClick={() =>
                void write('repos.provider.adopt', at).then((r) =>
                  setNote(
                    r.error
                      ? r.error.message
                      : `It syncs through your ${name} account now.`,
                  ),
                )
              }
            >
              Keep it in sync with my account
            </Button>
          )}
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {link.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      {note && <p className="text-xs">{note}</p>}
    </section>
  )
}

function Mirrors({ repo }: { repo: Repo }) {
  const at = { owner: repo.owner, repo: repo.name }
  const write = useWrite()
  const [error, setError] = React.useState('')
  const raw = useOp('mirrors.list', at).data
  const pausedIds = new Set(raw.filter((m) => m.paused).map((m) => m.id))
  const list: Array<Mirror> = raw.map((m) => ({
    id: m.id,
    host: m.host as Host,
    slug: m.slug,
    direction: m.direction,
    state: m.state,
    last: timeAgo(m.last_sync_at),
    detail: m.detail ?? undefined,
    carries: { issues: false, changes: false, releases: false, wiki: false },
  }))
  const [adding, setAdding] = React.useState(false)
  const [primary, setPrimary] = React.useState(false)
  return (
    <div className="max-w-3xl space-y-8">
      <ProviderLinkCard at={at} />
      <div className="surface rounded-2xl border bg-card p-4 text-sm">
        <div className="flex items-start gap-3">
          <CheckCircleIcon className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="space-y-1">
            <p className="font-medium">
              Everything lives here, whatever the other hosts do.
            </p>
            <p className="text-muted-foreground">
              Commits, branches, tags, issues, changes with their reviews, and
              releases are stored on cobalt. If a host goes down or you stop
              using it, nothing here changes, and mirrors catch up when it
              returns.
            </p>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Mirrors</h3>
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon /> Add a mirror
          </Button>
        </div>
        {list.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No mirrors. This repository only exists here.
          </p>
        ) : (
          <ul className="divide-y surface overflow-hidden rounded-2xl border bg-card">
            {list.map((m) => (
              <MirrorRow
                key={m.id}
                m={m}
                paused={pausedIds.has(m.id)}
                onPause={(paused) =>
                  void write('mirrors.update', {
                    ...at,
                    mirror: m.id,
                    body: { paused },
                  }).then((r) => setError(r.error?.message ?? ''))
                }
                onSync={() =>
                  write('mirrors.sync', { ...at, mirror: m.id }).then((r) =>
                    setError(r.error?.message ?? ''),
                  )
                }
                onRemove={() =>
                  void write('mirrors.delete', { ...at, mirror: m.id }).then(
                    (r) => setError(r.error?.message ?? ''),
                  )
                }
              />
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-muted-foreground">
          People who visit this project never see these hosts. They are shown to
          you only.
        </p>
      </section>

      <section className="space-y-3 border-t pt-6">
        <h3 className="text-sm font-medium">Leaving a host</h3>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          When you are ready to stop using another host for this project, make
          cobalt the only place people push. Mirrors keep receiving a copy until
          you remove them.
        </p>
        <SwitchRow
          checked={primary}
          onChange={setPrimary}
          label="Only accept pushes here"
          hint="Pushes to mirrors are rejected on their side with a link back to this repository."
        />
        <Link
          to="/settings/$section"
          params={{ section: 'accounts' }}
          className="inline-block py-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Manage connected accounts and imported history
        </Link>
      </section>
      <AddMirror
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(m) =>
          void write('mirrors.create', {
            ...at,
            body: { host: m.host, slug: m.slug, direction: m.direction },
          }).then((r) => setError(r.error?.message ?? ''))
        }
      />
    </div>
  )
}

function Contributions({ repo }: { repo: Repo }) {
  const at = { owner: repo.owner, repo: repo.name }
  const shown = useOp('repos.get', at)
  const write = useWrite()
  const [error, setError] = React.useState('')
  const save = (body: {
    auto_land?: boolean
    github_bot_writes?: boolean
    declined_models?: Array<string>
    vouched?: Array<string>
    denounced?: Array<{ handle: string; reason: string }>
  }) =>
    void write('repos.update', { ...at, body }).then((r) =>
      setError(r.error?.message ?? ''),
    )
  return (
    <div className="max-w-2xl space-y-10">
      <SwitchRow
        checked={shown.auto_land}
        onChange={(on) => save({ auto_land: on })}
        label="Land changes when everything is green"
        hint="Checks pass, no open high finding, the policy is met: it lands under your account, with no button to press. Never a draft, a stacked change, or one that touches CI, policies or the env schema."
      />

      {shown.upstream?.host === 'github' ? (
        <SwitchRow
          checked={shown.github_bot_writes}
          onChange={(on) => save({ github_bot_writes: on })}
          label="Let people without a GitHub account write"
          hint="This repository is mirrored to GitHub. Off: issues, comments and changes need the writer's own linked GitHub account, so GitHub shows their name. On: the cobalt app posts for people who have none, with their cobalt name in the text. Commits always keep their author either way."
        />
      ) : null}

      <ListEditor
        label="Declined models"
        hint="Changes declared with one of these models are turned away. The model is what the tool says it used; this stops tools that report honestly."
        placeholder="Claude Haiku 5.5"
        items={shown.declined_models}
        onChange={(declined_models) => save({ declined_models })}
      />

      <ListEditor
        label="Vouched"
        hint="People you trust. Their changes are listed first. They go through the same checks as everyone."
        placeholder="handle"
        items={shown.vouched}
        onChange={(vouched) => save({ vouched })}
      />

      <Denounced
        items={shown.denounced}
        onChange={(denounced) => save({ denounced })}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

function ListEditor({
  label,
  hint,
  placeholder,
  items,
  onChange,
}: {
  label: string
  hint: string
  placeholder: string
  items: Array<string>
  onChange: (next: Array<string>) => void
}) {
  const [draft, setDraft] = React.useState('')
  const add = () => {
    const v = draft.trim()
    if (!v || items.includes(v)) return
    onChange([...items, v])
    setDraft('')
  }
  return (
    <section className="space-y-3">
      <div className="text-sm">
        <h3 className="font-medium">{label}</h3>
        <p className="text-muted-foreground">{hint}</p>
      </div>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {items.map((x) => (
            <li
              key={x}
              className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-3 text-sm"
            >
              {x}
              <button
                type="button"
                aria-label={`Remove ${x}`}
                onClick={() => onChange(items.filter((y) => y !== x))}
                className="rounded-full px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-ring"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <Input
          aria-label={`Add to ${label.toLowerCase()}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
    </section>
  )
}

function Denounced({
  items,
  onChange,
}: {
  items: Array<{ handle: string; reason: string }>
  onChange: (next: Array<{ handle: string; reason: string }>) => void
}) {
  const [handle, setHandle] = React.useState('')
  const [reason, setReason] = React.useState('')
  return (
    <section className="space-y-3">
      <div className="text-sm">
        <h3 className="font-medium">Denounced</h3>
        <p className="text-muted-foreground">
          Accounts that may not open changes or issues here. They are told why,
          so say it plainly.
        </p>
      </div>
      {items.length > 0 && (
        <ul className="divide-y rounded-xl border text-sm">
          {items.map((d) => (
            <li key={d.handle} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">{d.handle}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {d.reason}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange(items.filter((x) => x.handle !== d.handle))
                }
              >
                Lift
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!handle.trim() || !reason.trim()) return
          onChange([
            ...items.filter((x) => x.handle !== handle.trim()),
            { handle: handle.trim(), reason: reason.trim() },
          ])
          setHandle('')
          setReason('')
        }}
      >
        <Input
          aria-label="Account to denounce"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="handle"
          className="w-40"
        />
        <Input
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why"
          className="min-w-48 flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!handle.trim() || !reason.trim()}
        >
          Denounce
        </Button>
      </form>
    </section>
  )
}

export function RepoSettings({
  repo,
  section,
}: {
  repo: Repo
  section?: string
}) {
  const current: Section =
    sections.find(([id]) => id === section)?.[0] ?? 'general'
  const slug = slugOf(repo)
  return (
    <>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav
          aria-label="Repository settings"
          className="flex gap-1 overflow-x-auto lg:sticky lg:top-header lg:flex-col lg:self-start"
        >
          {sections.map(([id, label]) => (
            <Link
              key={id}
              to="/$handle/$repo/$tab"
              params={{ handle: repo.owner, repo: repo.name, tab: 'settings' }}
              search={{ section: id }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors focus-ring-inset hover:bg-muted hover:text-foreground',
                id === current && 'bg-muted font-medium text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          {current === 'general' && (
            <>
              <Title title="General" />
              <General repo={repo} />
            </>
          )}
          {current === 'mirrors' && (
            <>
              <Title title="Mirrors and sync">
                Keep copies of this repository on other hosts, without making
                them depend on each other.
              </Title>
              <Mirrors repo={repo} />
            </>
          )}
          {current === 'secrets' && <SecretsPage repo={repo} />}
          {current === 'access' && <AccessPage repo={repo} />}
          {current === 'policies' && <PoliciesPage repo={repo} />}
          {current === 'automations' && <AutomationsPage repo={repo} />}
          {current === 'runners' && <RepoRunnersPage repo={repo} />}
          {current === 'contributions' && (
            <>
              <Title title="Contributions">
                What this repository takes, whose changes come first, and
                whether a change can land by itself. The same checks hold for
                every account.
              </Title>
              <Contributions repo={repo} />
            </>
          )}
          {current === 'integrations' && (
            <>
              <Title title="Integrations">
                Services this repository uses. Connect a service once in your
                account settings; turn it on here.{' '}
                <Link
                  to="/settings/$section"
                  params={{ section: 'integrations' }}
                  className="underline underline-offset-4"
                >
                  Account integrations
                </Link>
              </Title>
              <IntegrationsPanel repo={slug} />
            </>
          )}
        </div>
      </div>
    </>
  )
}
