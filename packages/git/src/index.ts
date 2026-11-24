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
} from './types'
export { GitNotConfigured } from './pierre'

export const readCache = createReadCache()

/** The repository in Code Storage named `id`. Throws when it is not configured. */
export function getGitRepo(id: string): GitRepo {
  return readCache.wrap(id, guarded(pierreRepo(pierreFromEnv(), id)))
}
