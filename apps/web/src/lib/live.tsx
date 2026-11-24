import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Query, QueryClient } from '@tanstack/react-query'

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

const repoOf = (input: Record<string, unknown>) =>
  typeof input.owner === 'string' && typeof input.repo === 'string'
    ? `${input.owner}/${input.repo}`.toLowerCase()
    : null

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
  const seen = React.useRef<Watched | undefined>(undefined)
  React.useEffect(() => {
    if (live === undefined) return
    const before = seen.current
    seen.current = live
    if (before) invalidateMoved(queries, before, live)
  }, [live, queries])
  return null
}

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
      return me || (!a && (repos.size > 0 || accounts.size > 0))
    },
  })
}
