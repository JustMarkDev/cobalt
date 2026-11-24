import { getGitRepo } from '@cobaltforge/git'
import type { GitStores } from '@cobaltforge/git/stores'
import { apiError } from './problem'
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

export interface GitData {
  files: (
    repo: string,
    ref?: string,
  ) => Promise<{ ref: string; paths: Array<string>; complete?: boolean }>
  blob: (repo: string, path: string, ref?: string) => Promise<Uint8Array | null>
  commits: (repo: string, limit: number) => Promise<Array<GitCommit>>
  commit: (repo: string, sha: string) => Promise<GitCommit>
  diff: (
    repo: string,
    sha: string,
  ) => Promise<{ sha: string; base: string | null; files: Array<GitDiffFile> }>
  setRepo?: (repo: string, storeId: string) => void
  /** Makes sure the store of a repository exists where the git data lives. */
  provision?: (
    storeId: string,
    opts?: {
      upstream?: { owner: string; name: string }
      defaultBranch?: string
    },
  ) => Promise<void>
  pull?: (storeId: string) => Promise<void>
  detach?: (storeId: string) => Promise<void>
  dropRepo?: (repo: string) => void
  storeOf?: (repo: string) => string | undefined
}

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
    }
  }

  provision?: GitData['provision']
  pull?: GitData['pull']
  detach?: GitData['detach']

  setRepo(repo: string, storeId: string) {
    this.stores.set(repo.toLowerCase(), storeId)
  }

  dropRepo(repo: string) {
    this.stores.delete(repo.toLowerCase())
  }

  storeOf(repo: string) {
    return this.stores.get(repo.toLowerCase())
  }

  /**
   * Where the store of a repository is named, when the server does not know it
   * yet. A server that sets it never guesses a store from the repository name.
   */
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

  files(repo: string, ref?: string) {
    return guarded(`The ref ${ref ?? 'main'}`, async () => {
      const store = await this.repo(repo)
      const paths: Array<string> = []
      let cursor: string | undefined
      let resolved = ref ?? ''
      for (let page = 0; page < 100; page++) {
        const r = await store.listFiles({ ref, recursive: true, cursor })
        resolved = r.ref
        paths.push(...r.paths)
        if (!r.hasMore || !r.nextCursor)
          return { ref: resolved, paths, complete: true }
        cursor = r.nextCursor
      }
      return { ref: resolved, paths, complete: false }
    })
  }

  blob(repo: string, path: string, ref?: string) {
    return guarded(`${path} at ${ref ?? 'main'}`, async () => {
      const res = await (await this.repo(repo)).getFileStream({ path, ref })
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
    })
  }

  commits(repo: string, limit: number) {
    return guarded('The history', async () =>
      (await (await this.repo(repo)).listCommits({ limit })).commits.map(
        commitOf,
      ),
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
}
