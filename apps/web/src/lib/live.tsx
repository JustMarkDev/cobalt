import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Query, QueryClient } from '@tanstack/react-query'

/**
 * Keeps what is on screen current. The page's reads are named by their query
 * keys (`['cb', id, input]`), and their inputs say which repository or
 * account each is about. One live Convex query watches just those, and the
 * viewer's own things; when one moves, only the reads about it are fetched
 * again. A write in one repository does not make every open page read
 * everything again.
 */
type Scope = { repos: Array<string>; accounts: Array<string> }
type Watched = {
  repos: Record<string, number>
  accounts: Record<string, number>
  me: string
}

const inputOf = (q: Pick<Query, 'queryKey'>) => {
  const [root, , input] = q.queryKey
  if (root !== 'cb' || !input || typeof input !== 'object') return null
  return input as Record<string, unknown>
}

/** The repository a read is about, as `owner/name`, lowercase. */
const repoOf = (input: Record<string, unknown>) =>
  typeof input.owner === 'string' && typeof input.repo === 'string'
    ? `${input.owner}/${input.repo}`.toLowerCase()
    : null

/** The account a read is about, when it is about no repository. */
const accountOf = (input: Record<string, unknown>) =>
  typeof input.handle === 'string'
    ? input.handle
    : typeof input.owner === 'string' && typeof input.repo !== 'string'
      ? input.owner
      : typeof input.org === 'string'
        ? input.org
        : null

function scopeOf(all: ReadonlyArray<Pick<Query, 'queryKey'>>): Scope {
  const repos = new Set<string>()
  const accounts = new Set<string>()
  for (const q of all) {
    const input = inputOf(q)
    if (!input) continue
    const r = repoOf(input)
    if (r) repos.add(r)
    else {
      const a = accountOf(input)
      if (a) accounts.add(a)
    }
  }
  return { repos: [...repos].sort(), accounts: [...accounts].sort() }
}

const same = (a: Scope, b: Scope) =>
  a.repos.join() === b.repos.join() && a.accounts.join() === b.accounts.join()

const nobody: Scope = { repos: [], accounts: [] }

/**
 * What the page reads, as a store over the query cache. It looks again a
 * moment after reads come and go, and keeps the old scope when nothing that
 * matters changed, so the live query is not re-subscribed for nothing.
 */
function scopeStore(queries: QueryClient) {
  const cache = queries.getQueryCache()
  let scope = scopeOf(cache.getAll())
  return {
    get: () => scope,
    subscribe: (changed: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const compute = () => {
        const next = scopeOf(cache.getAll())
        if (same(scope, next)) return
        scope = next
        changed()
      }
      compute()
      const stop = cache.subscribe((e) => {
        if (e.type !== 'added' && e.type !== 'removed') return
        clearTimeout(timer)
        timer = setTimeout(compute, 100)
      })
      return () => {
        clearTimeout(timer)
        stop()
      }
    },
  }
}

export function LiveForge() {
  const queries = useQueryClient()
  const store = React.useMemo(() => scopeStore(queries), [queries])
  const scope = React.useSyncExternalStore(
    store.subscribe,
    store.get,
    () => nobody,
  )
  const live = useQuery(api.forge.live.watch, scope)
  // The last answer, kept across scopes: a key in both is compared.
  const seen = React.useRef<Watched | undefined>(undefined)
  React.useEffect(() => {
    if (live === undefined) return
    const before = seen.current
    seen.current = live
    if (before) invalidateMoved(queries, before, live)
  }, [live, queries])
  return null
}

/** Read again what is about a repository or account whose version moved. */
function invalidateMoved(queries: QueryClient, before: Watched, live: Watched) {
  const moved = (was: Record<string, number>, now: Record<string, number>) =>
    new Set(Object.keys(now).filter((k) => k in was && was[k] !== now[k]))
  const repos = moved(before.repos, live.repos)
  const accounts = moved(before.accounts, live.accounts)
  const me = before.me !== live.me
  if (!repos.size && !accounts.size && !me) return
  void queries.invalidateQueries({
    predicate: (q) => {
      const input = inputOf(q)
      if (!input) return false
      const r = repoOf(input)
      if (r) return repos.has(r)
      const a = accountOf(input)
      if (a && accounts.has(a)) return true
      // A read about no one place (the dashboard, notifications) follows
      // the viewer, and anything the page watches.
      return me || (!a && (repos.size > 0 || accounts.size > 0))
    },
  })
}
