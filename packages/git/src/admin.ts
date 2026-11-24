import { ApiError, GitStorage } from '@pierre/storage'

export interface GitAdmin {
  deleteStore: (storeId: string) => Promise<void>
  size: (storeId: string) => Promise<number>
  egress?: (
    sinceMs: number,
  ) => Promise<Array<{ storeId: string; bytes: number }>>
}

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

export class MemoryGitAdmin implements GitAdmin {
  readonly stores = new Map<string, number>()
  readonly deleted: Array<string> = []
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
