import { ApiError, GitStorage } from '@pierre/storage'

/**
 * What the store worker needs from code.storage beyond reading: deleting a
 * repository's store, and knowing how big it is. Kept apart from `GitRepo`
 * (the read slice the app serves from) because only the worker holds the
 * credentials for it.
 */
export interface GitAdmin {
  /** Deletes a store. A store that is already gone is not an error. */
  deleteStore: (storeId: string) => Promise<void>
  /** Bytes the store holds, as best the store can tell. */
  size: (storeId: string) => Promise<number>
  /**
   * Bytes sent out of each store since `sinceMs` (clones, fetches), for the
   * stores that sent any. Optional: code.storage's SDK does not report it, so
   * the real adapter omits it until the API does, and the worker then reports
   * no transfer.
   */
  egress?: (
    sinceMs: number,
  ) => Promise<Array<{ storeId: string; bytes: number }>>
}

/**
 * code.storage, through its SDK. `name` and `key` are the ones the store was
 * provisioned with (`CODE_STORAGE_NAME`, `CODE_STORAGE_KEY`).
 *
 * `size` adds up the files at the default branch's head. That is the part a
 * person sees and a fair measure of what the plan counts; history that has
 * grown past it is not in the number until the store reports its own size.
 */
export function codeStorageAdmin(o: { name: string; key: string }): GitAdmin {
  const store = new GitStorage({ name: o.name, key: o.key })
  return {
    async deleteStore(storeId) {
      try {
        await store.deleteRepo({ id: storeId })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return
        throw e
      }
    },
    async size(storeId) {
      const repo = await store.findOne({ id: storeId })
      if (!repo) return 0
      let bytes = 0
      let cursor: string | undefined
      do {
        const page = await repo.listFilesWithMetadata({
          ...(cursor ? { cursor } : {}),
          limit: 1000,
        })
        for (const f of page.files) bytes += f.size
        cursor = page.hasMore ? page.nextCursor : undefined
      } while (cursor)
      return bytes
    },
  }
}

/** In memory, for tests and for running without code.storage. */
export class MemoryGitAdmin implements GitAdmin {
  readonly stores = new Map<string, number>()
  readonly deleted: Array<string> = []
  /** Bytes each store has sent out since the last `egress` call. */
  readonly out = new Map<string, number>()
  deleteStore(storeId: string) {
    this.stores.delete(storeId)
    this.deleted.push(storeId)
    return Promise.resolve()
  }
  size(storeId: string) {
    return Promise.resolve(this.stores.get(storeId) ?? 0)
  }
  egress() {
    const all = [...this.out].map(([storeId, bytes]) => ({ storeId, bytes }))
    this.out.clear()
    return Promise.resolve(all)
  }
}
