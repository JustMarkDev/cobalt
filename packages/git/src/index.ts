import { createReadCache } from './cached'
import { guarded } from './guarded'
import { pierreFromEnv, pierreRepo } from './pierre'
import type { GitRepo } from './types'

export { GitError } from './types'
export type {
  CommitInfo,
  FileDiff,
  GitRepo,
  ListCommitsOptions,
  ListFilesOptions,
  MergeOptions,
} from './types'
export { GitNotConfigured } from './pierre'

export const readCache = createReadCache()

export function getGitRepo(id: string): GitRepo {
  return readCache.wrap(id, guarded(pierreRepo(pierreFromEnv(), id)))
}
