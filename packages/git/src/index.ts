import { createReadCache } from './cached'
import { guarded } from './guarded'
import { pierreFromEnv, pierreRepo } from './pierre'
import { sharedTierFromEnv } from './redis-tier'
import type { GitRepo } from './types'

export { GitError } from './types'
export type {
  CommitFilesOptions,
  CommitInfo,
  FileDiff,
  GitRepo,
  ListCommitsOptions,
  ListFilesOptions,
  MergeOptions,
} from './types'
export { GitNotConfigured } from './pierre'
export type { SharedTier } from './cached'

export const readCache = createReadCache({ shared: sharedTierFromEnv() })

export function getGitRepo(id: string): GitRepo {
  return readCache.wrap(id, guarded(pierreRepo(pierreFromEnv(), id)))
}
