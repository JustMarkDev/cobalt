import type { GitRepo } from './types'

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export type ReadCacheOptions = {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

type Snapshot = {
  status: number
  headers: Array<[string, string]>
  body: ArrayBuffer
}

type Entry = { value: Promise<unknown>; expires: number | null }

export function createReadCache(opts: ReadCacheOptions = {}) {
  const ttlMs = opts.ttlMs ?? 15_000
  const maxEntries = opts.maxEntries ?? 500
  const now = opts.now ?? Date.now
  const entries = new Map<string, Entry>()
  const stats = { hits: 0, misses: 0 }

  const keyOf = (id: string, method: string, args: object) =>
    `${id}\u0000${method}\u0000${JSON.stringify(args)}`

  function read<T>(key: string, pinned: boolean, load: () => Promise<T>) {
    const hit = entries.get(key)
    if (hit && (hit.expires === null || hit.expires > now())) {
      entries.delete(key)
      entries.set(key, hit)
      stats.hits++
      return hit.value as Promise<T>
    }
    stats.misses++
    const value = load()
    entries.set(key, { value, expires: pinned ? null : now() + ttlMs })
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key)
    })
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    return value
  }

  const data = <T>(
    id: string,
    method: string,
    args: object,
    pinned: boolean,
    load: () => Promise<T>,
  ) =>
    read(keyOf(id, method, args), pinned, load).then((v) => structuredClone(v))

  return {
    stats,
    invalidate(id: string) {
      for (const [key, entry] of entries)
        if (key.startsWith(`${id}\u0000`) && entry.expires !== null)
          entries.delete(key)
    },
    purge(id: string) {
      for (const key of entries.keys())
        if (key.startsWith(`${id}\u0000`)) entries.delete(key)
    },
    wrap(id: string, repo: GitRepo): GitRepo {
      return {
        listFiles: (o) =>
          data(
            id,
            'listFiles',
            { ref: o?.ref, recursive: o?.recursive, cursor: o?.cursor },
            FULL_SHA.test(o?.ref ?? ''),
            () => repo.listFiles(o),
          ),
        listCommits: (o) =>
          data(
            id,
            'listCommits',
            {
              branch: o?.branch,
              cursor: o?.cursor,
              limit: o?.limit,
              path: o?.path,
            },
            false,
            () => repo.listCommits(o),
          ),
        getCommit: (o) =>
          data(id, 'getCommit', { sha: o.sha }, FULL_SHA.test(o.sha), () =>
            repo.getCommit(o),
          ),
        getCommitDiff: (o) =>
          data(id, 'getCommitDiff', { sha: o.sha }, FULL_SHA.test(o.sha), () =>
            repo.getCommitDiff(o),
          ),
        async getFileStream(o) {
          const key = keyOf(id, 'getFileStream', { path: o.path, ref: o.ref })
          const snap = await read<Snapshot>(
            key,
            FULL_SHA.test(o.ref ?? ''),
            async () => {
              const res = await repo.getFileStream(o)
              return {
                status: res.status,
                headers: [...res.headers.entries()],
                body: await res.arrayBuffer(),
              }
            },
          )
          if (snap.status >= 400) entries.delete(key)
          return new Response(snap.body.slice(0), {
            status: snap.status,
            headers: snap.headers,
          })
        },
      }
    },
  }
}
