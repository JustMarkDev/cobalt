import { pierreFromEnv } from './pierre'
import type { Pierre } from '@pierre/sdk'

export type Upstream = { owner: string; name: string }

/** Makes the repositories that hold the git data. `storeId` is the name in Code Storage. */
export interface GitStores {
  /**
   * Makes the store, or leaves it be when it exists: Code Storage creates
   * idempotently on the name, so a retry after a failure heals.
   */
  provision: (
    storeId: string,
    opts?: { upstream?: Upstream; defaultBranch?: string },
  ) => Promise<void>
  /** Asks Code Storage to fetch from GitHub now. */
  pull: (storeId: string) => Promise<void>
  /** Cuts the link to GitHub. The copy on GitHub stays as it is. */
  detach: (storeId: string) => Promise<void>
}

export function codeStorageStores(
  pierre: () => Pierre = () => pierreFromEnv(),
): GitStores {
  return {
    async provision(storeId, opts) {
      await pierre().repos.create({
        repo_name: storeId,
        ...(opts?.defaultBranch ? { default_branch: opts.defaultBranch } : {}),
        ...(opts?.upstream
          ? {
              upstream: {
                provider: 'github' as const,
                owner: opts.upstream.owner,
                name: opts.upstream.name,
              },
            }
          : {}),
      })
    },
    async pull(storeId) {
      await pierre().repos.upstream.pull({ repo_name: storeId })
    },
    async detach(storeId) {
      await pierre().repos.upstream.delete({ repo_name: storeId })
    },
  }
}
