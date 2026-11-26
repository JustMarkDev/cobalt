import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  CheckIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { api } from '../../../../../convex/_generated/api'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { Input } from '~/components/ui/input'
import { Select, SelectItem } from '~/components/ui/select'
import { manages, useAccounts } from '~/lib/auth/accounts'
import { useWrite } from '~/lib/forge'

export type ProviderId = 'github' | 'gitlab' | 'codeberg'

/**
 * Hosts you can link and import from today. The others are built but not
 * offered until they are tested end to end; they show as Planned.
 */
export const liveProviders: ReadonlySet<string> = new Set<ProviderId>([
  'github',
])

export const providerLabel: Record<ProviderId, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
}

type Repo = {
  slug: string
  private: boolean
  archived: boolean
  fork: boolean
  description: string
  can_push: boolean | null
  linked: string | null
  size_bytes: number
}

type Progress = {
  state: 'running' | 'done' | 'cancelled'
  total: number
  done: number
  failed: number
  items: Array<{
    slug: string
    state: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
    repo: string | null
    error: string | null
  }>
}

export const size = (n: number) =>
  n < 1e6
    ? `${Math.max(1, Math.round(n / 1e3))} KB`
    : n < 1e9
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.round((n / 1e9) * 100) / 100} GB`

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

function useJob(id: string | null): Progress | null {
  const raw = useQuery(api.forge.providers.jobProgress, id ? { id } : 'skip')
  return React.useMemo(() => {
    if (typeof raw !== 'string') return null
    try {
      return JSON.parse(raw) as Progress | null
    } catch {
      return null
    }
  }, [raw])
}

export function ProviderPicker({
  provider,
  githubAccess,
  returnTo,
  empty,
  actions,
}: {
  provider: ProviderId
  githubAccess?: string
  returnTo: string | null
  empty?: React.ReactNode
  actions?: React.ReactNode
}) {
  const write = useWrite()
  const { me, accounts, active } = useAccounts()
  const owners = accounts.filter((a) => me && manages(a))
  const [ownerId, setOwnerId] = React.useState<string | null>(null)
  const owner =
    owners.find((a) => a.id === ownerId) ??
    owners.find((a) => a.id === active?.id) ??
    owners.at(0)
  const [repos, setRepos] = React.useState<Array<Repo> | null>(null)
  const [next, setNext] = React.useState<string | null>(null)
  const [q, setQ] = React.useState('')
  const [forks, setForks] = React.useState(false)
  const [archived, setArchived] = React.useState(false)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [jobId, setJobId] = React.useState<string | null>(null)
  const job = useJob(jobId)
  const plan = usePlan()
  const label = providerLabel[provider]

  const page = React.useCallback(
    async (cursor: string | null) => {
      setLoading(true)
      const r = await write('providers.repos.list', {
        provider,
        body: {
          ...(githubAccess ? { github_access: githubAccess } : {}),
          ...(cursor ? { cursor } : {}),
        },
      })
      setLoading(false)
      if (r.error) return setError(r.error.message)
      setError(null)
      setRepos((had) => [
        ...(cursor ? (had ?? []) : []),
        ...(r.data.data as Array<Repo>),
      ])
      setNext(r.data.next_cursor)
    },
    [write, provider, githubAccess],
  )

  React.useEffect(() => {
    void page(null)
    const again = () => {
      if (document.visibilityState === 'visible') void page(null)
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [page])

  const needle = q.trim().toLowerCase()
  const shown = (repos ?? []).filter(
    (r) =>
      (forks || !r.fork) &&
      (archived || !r.archived) &&
      (!needle ||
        r.slug.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle)),
  )
  const inJob = new Map((job?.items ?? []).map((i) => [i.slug, i]))
  const free = shown.filter(
    (r) => !r.linked && r.can_push !== false && !inJob.has(r.slug),
  )
  const chosen = free.filter((r) => picked.has(r.slug))
  const allPicked = free.length > 0 && chosen.length === free.length
  const chosenBytes = chosen.reduce((n, r) => n + r.size_bytes, 0)
  const room =
    plan && !plan.unlimited && plan.limits
      ? plan.limits.storageGb * 1e9 - plan.usage.storageBytes
      : null
  const tooBig = room !== null && chosenBytes > room
  const running = job?.state === 'running'

  async function run() {
    if (!owner || !chosen.length) return
    const r = await write('imports.batch', {
      body: {
        provider,
        slugs: chosen.map((x) => x.slug),
        owner: owner.handle,
        ...(githubAccess ? { github_access: githubAccess } : {}),
      },
    })
    if (r.error) return setError(r.error.message)
    setJobId(r.data.id)
    setPicked(new Set())
  }

  return (
    <div className="space-y-6">
      <Callout tone="warning" title="Who can push is decided here">
        Anyone who can write to an imported repository here can push to it on{' '}
        {label} through Cobalt, even if {label} would refuse them. {label}
        &apos;s branch protection rules still apply to those pushes. Set up the
        same rules here before you invite people.
        {provider !== 'github' &&
          ` Git LFS objects do not travel between Cobalt and ${label}.`}
      </Callout>

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
            onClick={() => void page(null)}
            aria-label="Refresh the list"
          >
            <ArrowPathIcon className="size-4" />
          </Button>
          {actions}
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
        (empty ?? (
          <p className="text-sm text-muted-foreground">
            Your {label} account has no repositories you can push to.
          </p>
        ))
      ) : (
        repos && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="relative min-w-56 flex-1">
                <MagnifyingGlassIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Find a repository"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Find a repository"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={forks}
                  onChange={(e) => setForks(e.target.checked)}
                />
                Forks
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Archived
              </label>
              <Button
                variant="ghost"
                size="sm"
                disabled={free.length === 0 || running}
                onClick={() =>
                  setPicked(
                    allPicked ? new Set() : new Set(free.map((r) => r.slug)),
                  )
                }
              >
                {allPicked ? 'Select none' : `Select all ${free.length}`}
              </Button>
            </div>

            <ul className="surface divide-y overflow-hidden rounded-2xl border bg-card text-sm">
              {shown.map((r) => {
                const item = inJob.get(r.slug)
                const locked =
                  !!r.linked || r.can_push === false || !!item || running
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
                        checked={picked.has(r.slug) || item?.state === 'done'}
                        onChange={(e) =>
                          setPicked((all) => {
                            const n = new Set(all)
                            if (e.target.checked) n.add(r.slug)
                            else n.delete(r.slug)
                            return n
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {r.slug}
                      </span>
                      {r.archived && (
                        <ArchiveBoxIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-label="Archived"
                        />
                      )}
                      {r.private && (
                        <LockClosedIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-label="Private"
                        />
                      )}
                      <span
                        className={cn(
                          'shrink-0 text-xs tabular-nums',
                          item
                            ? item.state === 'failed'
                              ? 'text-danger'
                              : item.state === 'done'
                                ? 'text-success'
                                : 'text-muted-foreground'
                            : 'text-muted-foreground',
                        )}
                      >
                        {item
                          ? item.state === 'done'
                            ? `Syncing as ${item.repo}`
                            : item.state === 'failed'
                              ? (item.error ?? 'Failed')
                              : item.state === 'skipped'
                                ? (item.error ?? 'Skipped')
                                : item.state === 'running'
                                  ? 'Importing…'
                                  : 'Waiting…'
                          : r.linked
                            ? `Already here as ${r.linked}`
                            : r.can_push === false
                              ? 'You cannot push to it'
                              : size(r.size_bytes)}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            {next && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void page(next)}
              >
                {loading ? 'Loading…' : 'Show more'}
              </Button>
            )}
          </>
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
            {job
              ? `${job.done + job.failed} of ${job.total} done${job.failed ? `, ${job.failed} failed` : ''}.`
              : chosen.length === 0
                ? 'Pick the repositories to bring'
                : `${chosen.length} picked, ${size(chosenBytes)}`}
            {!job &&
              plan &&
              (plan.unlimited || !plan.limits
                ? '. Your account has no storage limit.'
                : `. ${size(Math.max(0, room ?? 0))} free on your ${plan.plan} plan.`)}
          </p>
          <div className="flex gap-2">
            {job?.state === 'done' && (
              <Button
                variant="outline"
                size="lg"
                render={
                  returnTo ? (
                    <a href={returnTo} />
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
                {returnTo ? 'Continue' : 'See your repositories'}
              </Button>
            )}
            <Button
              variant="brand"
              size="lg"
              disabled={chosen.length === 0 || running || tooBig || !owner}
              onClick={() => void run()}
            >
              {running ? (
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
  )
}
