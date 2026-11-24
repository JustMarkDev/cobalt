import { NotFoundError, Pierre } from '@pierre/sdk'

export interface GitAdmin {
  deleteStore: (storeId: string) => Promise<void>
  size: (storeId: string) => Promise<number>
  egress?: (
    sinceMs: number,
  ) => Promise<Array<{ storeId: string; bytes: number }>>
}

/** `storeId` is the repository name in Code Storage. */
export function codeStorageAdmin(o: {
  org: string
  privateKey: string
}): GitAdmin {
  const pierre = new Pierre({ org: o.org, privateKey: o.privateKey })
  return {
    async deleteStore(storeId) {
      try {
        await pierre.repos.delete({ repo_name: storeId })
      } catch (e) {
        if (e instanceof NotFoundError) return
        throw e
      }
    },
    async size(storeId) {
      let bytes = 0
      try {
        const first = await pierre.repos.files.metadata.list({
          repo_name: storeId,
          limit: 1000,
        })
        for await (const page of first.iterPages())
          for (const f of page.data) bytes += f.size
      } catch (e) {
        if (e instanceof NotFoundError) return 0
        throw e
      }
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
