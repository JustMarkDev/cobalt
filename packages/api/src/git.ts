import { getGitRepo } from '@cobaltforge/git'
import type { GitStores, ProvisionOptions } from '@cobaltforge/git/stores'
import { apiError } from './problem'
import type { EventLog } from './events'
import type { GitRepo } from '@cobaltforge/git'

export type GitCommit = {
  sha: string
  parents: Array<string>
  message: string
  author: { name: string; email: string }
  committer: { name: string; email: string }
  date: string
}

export type GitDiffFile = {
  path: string
  state: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  patch: string
}

export type GitBlameLine = {
  line: number
  sha: string
  author: { name: string; email: string }
  date: string
  summary: string
  originalPath: string
  originalLine: number
}

export type GitCompared = {
  sha: string
  base: string | null
  mergeBase: string | null
  files: Array<GitDiffFile>
}

export interface GitData {
  files: (
    repo: string,
    ref?: string,
  ) => Promise<{ ref: string; paths: Array<string>; complete?: boolean }>
  blob: (repo: string, path: string, ref?: string) => Promise<Uint8Array | null>
  commits: (
    repo: string,
    limit: number,
    from?: { ref?: string; path?: string },
  ) => Promise<Array<GitCommit>>
  commit: (repo: string, sha: string) => Promise<GitCommit>
  diff: (
    repo: string,
    sha: string,
  ) => Promise<{ sha: string; base: string | null; files: Array<GitDiffFile> }>
  blame: (
    repo: string,
    path: string,
    ref?: string,
  ) => Promise<{ ref: string; lines: Array<GitBlameLine> }>
  compare: (
    repo: string,
    base: string,
    head: string,
    path?: string,
  ) => Promise<GitCompared>
  setRepo?: (repo: string, storeId: string) => void
  provision?: (storeId: string, opts?: ProvisionOptions) => Promise<void>
  pull?: (storeId: string) => Promise<void>
  detach?: (storeId: string) => Promise<void>
  upstreams?: GitStores
  dropRepo?: (repo: string) => void
  storeOf?: (repo: string) => string | undefined
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const LISTINGS_KEPT = 32

type Listing = { ref: string; paths: Array<string>; complete: boolean }

const commitOf = (c: {
  sha: string
  parentShas: Array<string>
  message: string
  authorName: string
  authorEmail: string
  committerName: string
  committerEmail: string
  date: Date
}): GitCommit => ({
  sha: c.sha,
  parents: c.parentShas,
  message: c.message,
  author: { name: c.authorName, email: c.authorEmail },
  committer: { name: c.committerName, email: c.committerEmail },
  date: c.date.toISOString(),
})

async function guarded<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 404) throw apiError('not_found', `${what} was not found.`)
    throw e
  }
}

export class StoreGit implements GitData {
  private readonly stores = new Map<string, string>()
  constructor(
    private readonly open: (storeId: string) => GitRepo = getGitRepo,
    provisioner?: GitStores,
  ) {
    if (provisioner) {
      this.provision = (storeId, opts) => provisioner.provision(storeId, opts)
      this.pull = (storeId) => provisioner.pull(storeId)
      this.detach = (storeId) => provisioner.detach(storeId)
      this.upstreams = provisioner
    }
  }

  provision?: GitData['provision']
  pull?: GitData['pull']
  detach?: GitData['detach']
  upstreams?: GitStores

  setRepo(repo: string, storeId: string) {
    this.stores.set(repo.toLowerCase(), storeId)
  }

  dropRepo(repo: string) {
    this.stores.delete(repo.toLowerCase())
  }

  storeOf(repo: string) {
    return this.stores.get(repo.toLowerCase())
  }

  resolveStore?: (full: string) => Promise<string | null>

  private async repo(full: string) {
    const key = full.toLowerCase()
    let id = this.stores.get(key)
    if (!id && this.resolveStore) {
      id = (await this.resolveStore(full)) ?? undefined
      if (!id) throw apiError('not_found', `No repository ${full}.`)
      this.stores.set(key, id)
    }
    return this.open(id ?? full.split('/')[1])
  }

  // Whole file listings of repositories that take several pages to list, by
  // commit. A listing of a commit never changes, and putting one together costs
  // a call per page, so the newest few are kept.
  private readonly listings = new Map<string, Promise<Listing>>()

  files(repo: string, ref?: string) {
    return guarded(`The ref ${ref ?? 'main'}`, async () => {
      const store = await this.repo(repo)
      const first = await store.listFiles({ ref, recursive: true })
      if (!first.hasMore || !first.nextCursor)
        return { ref: first.ref, paths: first.paths, complete: true }
      // The rest is read at the commit the first page answered for, so the
      // pages are one listing even if the branch moves in between.
      const pinned = FULL_SHA.test(first.ref)
      const at = pinned ? first.ref : ref
      const rest = () => this.restOfListing(store, at, first)
      if (!pinned) return rest()
      const key = `${repo.toLowerCase()}\u0000${first.ref}`
      let listing = this.listings.get(key)
      if (listing) {
        this.listings.delete(key)
      } else {
        listing = rest()
        listing.catch(() => {
          if (this.listings.get(key) === listing) this.listings.delete(key)
        })
      }
      this.listings.set(key, listing)
      while (this.listings.size > LISTINGS_KEPT) {
        const oldest = this.listings.keys().next()
        if (oldest.done) break
        this.listings.delete(oldest.value)
      }
      const done = await listing
      return { ...done, paths: done.paths.slice() }
    })
  }

  private async restOfListing(
    store: GitRepo,
    ref: string | undefined,
    first: Awaited<ReturnType<GitRepo['listFiles']>>,
  ): Promise<Listing> {
    const paths = [...first.paths]
    let cursor = first.nextCursor
    for (let page = 1; page < 100; page++) {
      const r = await store.listFiles({ ref, recursive: true, cursor })
      paths.push(...r.paths)
      if (!r.hasMore || !r.nextCursor)
        return { ref: first.ref, paths, complete: true }
      cursor = r.nextCursor
    }
    return { ref: first.ref, paths, complete: false }
  }

  blob(repo: string, path: string, ref?: string) {
    return guarded(`${path} at ${ref ?? 'main'}`, async () => {
      const res = await (await this.repo(repo)).getFileStream({ path, ref })
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
    })
  }

  commits(repo: string, limit: number, from?: { ref?: string; path?: string }) {
    return guarded(
      from?.path ? `The history of ${from.path}` : 'The history',
      async () =>
        (
          await (
            await this.repo(repo)
          ).listCommits({
            limit,
            ...(from?.ref ? { branch: from.ref } : {}),
            ...(from?.path ? { path: from.path } : {}),
          })
        ).commits.map(commitOf),
    )
  }

  commit(repo: string, sha: string) {
    return guarded(`Commit ${sha}`, async () =>
      commitOf((await (await this.repo(repo)).getCommit({ sha })).commit),
    )
  }

  diff(repo: string, sha: string) {
    return guarded(`Commit ${sha}`, async () => {
      const d = await (await this.repo(repo)).getCommitDiff({ sha })
      return {
        sha: d.sha,
        base: d.baseSha ?? null,
        files: d.files.map((f) => ({
          path: f.path,
          state: f.state,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.raw,
        })),
      }
    })
  }
  blame(repo: string, path: string, ref?: string) {
    return guarded(`${path} at ${ref ?? 'main'}`, async () => {
      const b = await (await this.repo(repo)).blame({ path, ref })
      return {
        ref: b.sha,
        lines: b.lines.map((l) => ({
          line: l.line,
          sha: l.sha,
          author: { name: l.authorName, email: l.authorEmail },
          date: l.date.toISOString(),
          summary: l.summary,
          originalPath: l.originalPath,
          originalLine: l.originalLine,
        })),
      }
    })
  }

  compare(repo: string, base: string, head: string, path?: string) {
    return guarded(`${base}...${head}`, async () => {
      const c = await (
        await this.repo(repo)
      ).compare({ base, head, ...(path ? { paths: [path] } : {}) })
      return {
        sha: c.sha,
        base: c.baseSha ?? null,
        mergeBase: c.mergeBaseSha ?? null,
        files: c.files.map((f) => ({
          path: f.path,
          state: f.state,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.raw,
        })),
      }
    })
  }
}

/**
 * A push moves a branch, so what the read cache believes about where the
 * branches point is stale. Every server process hears the push on its own copy
 * of the event feed and forgets it. Content read by commit id stays: it never
 * changes.
 */
export function invalidateOnPush(
  events: Pick<EventLog, 'subscribe'>,
  git: Pick<GitData, 'storeOf'>,
  invalidate: (storeId: string) => void,
) {
  return events.subscribe((e) => {
    if (e.type !== 'repository.pushed' || !e.repo) return
    const id = git.storeOf?.(e.repo)
    if (id) invalidate(id)
  })
}
