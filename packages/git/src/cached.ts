import type { GitRepo } from './types'

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * A second cache tier shared by every server process. Only content addressed
 * by a full commit id goes through it: it never changes, so it needs no
 * invalidation and a stale or lost entry costs one more read from the store.
 * A tier that throws or times out is skipped; it can slow a read, never fail it.
 */
export interface SharedTier {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
}

export type ReadCacheOptions = {
  /** How long a read that follows a branch name (not a commit id) may be reused. */
  ttlMs?: number
  /** How long "branch X is at commit Y" may be reused. */
  headTtlMs?: number
  maxEntries?: number
  now?: () => number
  shared?: SharedTier
  /** Content larger than this stays out of the shared tier. */
  sharedMaxBytes?: number
}

type Snapshot = {
  status: number
  headers: Array<[string, string]>
  body: ArrayBuffer
}

type Entry = { value: Promise<unknown>; expires: number | null }

const DATE = '$date'

const encode = (v: unknown) =>
  JSON.stringify(v, function (this: Record<string, unknown>, k, x) {
    const raw = this[k]
    return raw instanceof Date ? { [DATE]: raw.toISOString() } : x
  })

const decode = (s: string) =>
  JSON.parse(s, (_k, x: unknown) =>
    x && typeof x === 'object' && DATE in x
      ? new Date((x as Record<string, string>)[DATE])
      : x,
  ) as unknown

const snapshotText = (v: Snapshot) =>
  v.status >= 400
    ? ''
    : JSON.stringify({
        status: v.status,
        headers: v.headers,
        body: Buffer.from(v.body).toString('base64'),
      })

const snapshotOf = (s: string): Snapshot => {
  const v = JSON.parse(s) as {
    status: number
    headers: Array<[string, string]>
    body: string
  }
  const b = Buffer.from(v.body, 'base64')
  return {
    status: v.status,
    headers: v.headers,
    body: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  }
}

export function createReadCache(opts: ReadCacheOptions = {}) {
  const ttlMs = opts.ttlMs ?? 15_000
  const headTtlMs = opts.headTtlMs ?? 5_000
  const maxEntries = opts.maxEntries ?? 500
  const now = opts.now ?? Date.now
  const shared = opts.shared
  const sharedMax = opts.sharedMaxBytes ?? 1 << 20
  const entries = new Map<string, Entry>()
  const stats = { hits: 0, misses: 0, sharedHits: 0, resolves: 0 }

  const keyOf = (id: string, method: string, args: object) =>
    `${id}\u0000${method}\u0000${JSON.stringify(args)}`

  async function fromShared(key: string): Promise<string | undefined> {
    if (!shared) return undefined
    try {
      return (await shared.get(key)) ?? undefined
    } catch {
      return undefined
    }
  }

  function toShared(key: string, text: string) {
    if (!shared || !text || text.length > sharedMax) return
    void shared.set(key, text).catch(() => {})
  }

  function remember<T>(
    key: string,
    ttl: number | null,
    load: () => Promise<T>,
  ) {
    const hit = entries.get(key)
    if (hit && (hit.expires === null || hit.expires > now())) {
      entries.delete(key)
      entries.set(key, hit)
      stats.hits++
      return hit.value as Promise<T>
    }
    stats.misses++
    const value = load()
    entries.set(key, { value, expires: ttl === null ? null : now() + ttl })
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

  /**
   * A read that goes through both tiers when `pinned`: content named by a full
   * commit id. `toText` and `fromText` turn it into text for the shared tier.
   */
  function read<T>(
    key: string,
    pinned: boolean,
    load: () => Promise<T>,
    toText: (v: T) => string,
    fromText: (s: string) => T,
  ) {
    if (!pinned || !shared) return remember(key, pinned ? null : ttlMs, load)
    return remember(key, null, async () => {
      const text = await fromShared(key)
      if (text !== undefined) {
        try {
          const value = fromText(text)
          stats.sharedHits++
          return value
        } catch {
          // A corrupt entry is a miss.
        }
      }
      const value = await load()
      toShared(key, toText(value))
      return value
    })
  }

  const data = <T>(
    id: string,
    method: string,
    args: object,
    pinned: boolean,
    load: () => Promise<T>,
  ) =>
    read<T>(
      keyOf(id, method, args),
      pinned,
      load,
      (v) => encode(v),
      (s) => decode(s) as T,
    ).then((v) => structuredClone(v))

  /** "Branch X is at commit Y": the only read that has to be fresh. */
  function head(id: string, repo: GitRepo, ref: string | undefined) {
    return remember(keyOf(id, 'head', { ref }), headTtlMs, async () => {
      stats.resolves++
      const page = await repo.listCommits({
        limit: 1,
        ...(ref ? { branch: ref } : {}),
      })
      const sha = page.commits[0]?.sha
      if (!sha || !FULL_SHA.test(sha)) throw new Error('unresolvable')
      return sha
    })
  }

  /**
   * The commit a ref points at now. Everything read below it is cached by
   * that commit id and never expires, so a branch that moves costs one small
   * lookup, not a refetch of every file. When the ref cannot be resolved the
   * read falls through unchanged, and the store answers (or refuses) it.
   */
  async function pin(id: string, repo: GitRepo, ref: string | undefined) {
    if (ref && FULL_SHA.test(ref)) return { ref, pinned: true }
    try {
      return { ref: await head(id, repo, ref), pinned: true }
    } catch {
      return { ref, pinned: false }
    }
  }

  const invalidate = (id: string) => {
    for (const [key, entry] of entries)
      if (key.startsWith(`${id}\u0000`) && entry.expires !== null)
        entries.delete(key)
  }
  return {
    stats,
    /** A push moved something: forget where branches point. Pinned content stays. */
    invalidate,
    purge(id: string) {
      for (const key of entries.keys())
        if (key.startsWith(`${id}\u0000`)) entries.delete(key)
    },
    wrap(id: string, repo: GitRepo): GitRepo {
      const merge = repo.merge?.bind(repo)
      const commitFiles = repo.commitFiles?.bind(repo)
      return {
        ...(commitFiles
          ? {
              commitFiles: async (o) => {
                const r = await commitFiles(o)
                invalidate(id)
                return r
              },
            }
          : {}),
        // A merge moves a branch: what was read of it is stale.
        ...(merge
          ? {
              merge: async (o) => {
                const r = await merge(o)
                invalidate(id)
                return r
              },
            }
          : {}),
        async listFiles(o) {
          const at = await pin(id, repo, o?.ref)
          return data(
            id,
            'listFiles',
            { ref: at.ref, recursive: o?.recursive, cursor: o?.cursor },
            at.pinned,
            () => repo.listFiles({ ...o, ...(at.ref ? { ref: at.ref } : {}) }),
          )
        },
        async listCommits(o) {
          const at = await pin(id, repo, o?.branch)
          return data(
            id,
            'listCommits',
            {
              branch: at.ref,
              cursor: o?.cursor,
              limit: o?.limit,
              path: o?.path,
            },
            at.pinned,
            () =>
              repo.listCommits({
                ...o,
                ...(at.ref ? { branch: at.ref } : {}),
              }),
          )
        },
        getCommit: (o) =>
          data(id, 'getCommit', { sha: o.sha }, FULL_SHA.test(o.sha), () =>
            repo.getCommit(o),
          ),
        getCommitDiff: (o) =>
          data(
            id,
            'getCommitDiff',
            { sha: o.sha, base: o.base },
            FULL_SHA.test(o.sha) && (!o.base || FULL_SHA.test(o.base)),
            () => repo.getCommitDiff(o),
          ),
        async blame(o) {
          const at = await pin(id, repo, o.ref)
          return data(
            id,
            'blame',
            { path: o.path, ref: at.ref },
            at.pinned,
            () =>
              repo.blame({ path: o.path, ...(at.ref ? { ref: at.ref } : {}) }),
          )
        },
        async compare(o) {
          const [from, to] = await Promise.all([
            pin(id, repo, o.base),
            pin(id, repo, o.head),
          ])
          return data(
            id,
            'compare',
            { base: from.ref, head: to.ref, paths: o.paths },
            from.pinned && to.pinned,
            () =>
              repo.compare({
                ...o,
                base: from.ref ?? o.base,
                head: to.ref ?? o.head,
              }),
          )
        },
        async getFileStream(o) {
          const at = await pin(id, repo, o.ref)
          const key = keyOf(id, 'getFileStream', { path: o.path, ref: at.ref })
          const snap = await read<Snapshot>(
            key,
            at.pinned,
            async () => {
              const res = await repo.getFileStream({
                ...o,
                ...(at.ref ? { ref: at.ref } : {}),
              })
              return {
                status: res.status,
                headers: [...res.headers.entries()],
                body: await res.arrayBuffer(),
              }
            },
            snapshotText,
            snapshotOf,
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
