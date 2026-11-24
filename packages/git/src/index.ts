import { createReadCache } from './cached'
import { fakeRepo } from './fake'
import { guarded } from './guarded'
import type { Repo } from '@pierre/storage'

export type GitRepo = Pick<
  Repo,
  'listFiles' | 'getFileStream' | 'listCommits' | 'getCommit' | 'getCommitDiff'
>

export const readCache = createReadCache()

export function getGitRepo(id: string): GitRepo {
  return readCache.wrap(id, guarded(fakeRepo(id)))
}
