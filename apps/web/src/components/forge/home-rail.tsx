import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  MagnifyingGlassIcon,
  PlusIcon,
  UserCircleIcon,
} from '@phosphor-icons/react'
import { cn } from 'cn'
import { AccountTile } from './organization'
import type { Account } from '~/lib/auth/accounts'
import type { Health } from '~/lib/model/dashboard'
import { Button } from '~/components/ui/button'
import { useAccounts } from '~/lib/auth/accounts'
import { useOp } from '~/lib/forge'

/** Who you are acting as, with the way to your public page. */
export function RailTop({ account }: { account: Account }) {
  const org = account.kind === 'organization'
  return (
    <div className="flex items-center gap-2.5 px-1">
      <AccountTile account={account} className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {account.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          @{account.handle}
        </span>
      </span>
      <Button
        size="icon-sm"
        variant="outline"
        aria-label={org ? 'Public page' : 'Public profile'}
        title={org ? 'Public page' : 'Public profile'}
        nativeButton={false}
        render={
          org ? (
            <Link to="/$handle" params={{ handle: account.handle }} />
          ) : (
            <Link to="/dashboard" search={{ view: 'profile' }} />
          )
        }
      >
        <UserCircleIcon />
      </Button>
    </div>
  )
}

/** Every repository you can push to, grouped by the account that owns it. */
export function RepoBrowser({
  health,
  className,
}: {
  health: { owner: string; repos: Record<string, Health | undefined> }
  className?: string
}) {
  const { accounts } = useAccounts()
  const [query, setQuery] = React.useState('')
  const q = query.trim().toLowerCase()
  return (
    <section
      aria-labelledby="rail-repos"
      className={cn('flex min-h-0 flex-col', className)}
    >
      <div className="mb-2 flex items-center justify-between px-2.5">
        <h2
          id="rail-repos"
          className="text-xs font-medium text-muted-foreground"
        >
          Repositories
        </h2>
        <Link
          to="/new"
          aria-label="New repository"
          className="-m-1 rounded-md p-1 text-muted-foreground focus-ring hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="size-4" />
        </Link>
      </div>
      <label className="mb-2 flex h-8 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm text-muted-foreground focus-within:border-ring">
        <MagnifyingGlassIcon className="size-3.5 shrink-0" />
        <span className="sr-only">Find a repository</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a repository"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          style={{ outline: 'none' }}
        />
      </label>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {accounts.map((a) => (
          <React.Suspense key={a.id} fallback={<GroupSkeleton />}>
            <RepoGroup
              account={a}
              query={q}
              titled={accounts.length > 1}
              health={a.handle === health.owner ? health.repos : {}}
            />
          </React.Suspense>
        ))}
      </div>
    </section>
  )
}

function GroupSkeleton() {
  return (
    <div className="space-y-1.5 px-2.5 py-2" aria-hidden="true">
      {[70, 55, 80].map((w) => (
        <div
          key={w}
          className="h-3.5 animate-pulse rounded bg-muted"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

function RepoGroup({
  account,
  query,
  titled,
  health,
}: {
  account: Account
  query: string
  titled: boolean
  health: Record<string, Health | undefined>
}) {
  const all = useOp('repos.list', { owner: account.handle, limit: 100 }).data
  const repos = all
    .filter((r) => !query || r.name.toLowerCase().includes(query))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  if (query && repos.length === 0) return null
  return (
    <div className="mb-3">
      {titled && (
        <div className="flex items-center gap-2 px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
          <AccountTile account={account} className="size-4 text-[8px]" />
          <span className="min-w-0 flex-1 truncate">
            {account.kind === 'person' ? 'Yours' : account.name}
          </span>
          <span className="tabular-nums">{all.length}</span>
        </div>
      )}
      {repos.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
          No repositories yet.
        </p>
      ) : (
        <ul>
          {repos.map((r) => {
            const h = health[r.name]
            return (
              <li key={r.id}>
                <Link
                  to="/$handle/$repo/$tab"
                  params={{ handle: r.owner, repo: r.name, tab: 'code' }}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm focus-ring-inset hover:bg-muted"
                  title={r.full_name}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      !h
                        ? 'bg-muted-foreground/40'
                        : h.checks === 'failing'
                          ? 'bg-danger'
                          : 'bg-success',
                    )}
                    aria-label={
                      h
                        ? h.checks === 'failing'
                          ? 'Checks failing'
                          : 'Checks passing'
                        : undefined
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {!titled && (
                      <span className="text-muted-foreground">{r.owner}/</span>
                    )}
                    {r.name}
                  </span>
                  {h && h.openChanges > 0 && (
                    <span
                      className="font-mono text-xs text-muted-foreground tabular-nums"
                      title={`${h.openChanges} open changes`}
                    >
                      {h.openChanges}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
