import type { GitAdmin } from '@cobaltforge/git/admin'
import type { BlobStore } from '../uploads'
import type { ConvexCall } from './convex'

type Claimed = {
  sweeps: Array<{ id: string; kind: 'git' | 'blob'; key: string }>
  measure: Array<string>
}

export type Tick = {
  deleted: number
  measured: number
  transferred: number
  failed: number
}

export class StoreWorker {
  private sinceEgress = Date.now()
  constructor(
    private readonly o: {
      call: ConvexCall
      secret: string
      git?: GitAdmin
      blobs?: BlobStore
      batch?: number
      onError?: (e: unknown) => void
    },
  ) {}

  async tick(): Promise<Tick> {
    const { call, secret, git, blobs } = this.o
    const kinds: Array<'git' | 'blob'> = []
    if (git) kinds.push('git')
    if (blobs?.delete) kinds.push('blob')
    const claimed = (await call('storeWorker:claim', {
      secret,
      kinds,
      measure: git !== undefined,
      max: this.o.batch ?? 50,
    })) as Claimed
    const result: Tick = { deleted: 0, measured: 0, transferred: 0, failed: 0 }
    const done: Array<string> = []
    for (const s of claimed.sweeps) {
      try {
        if (s.kind === 'git') await git!.deleteStore(s.key)
        else await blobs!.delete!(s.key)
        done.push(s.id)
        result.deleted++
      } catch (e) {
        result.failed++
        this.o.onError?.(e)
      }
    }
    if (done.length) await call('storeWorker:done', { secret, ids: done })
    for (const storeId of claimed.measure) {
      try {
        await call('storeWorker:reportSize', {
          secret,
          storeId,
          bytes: await git!.size(storeId),
        })
        result.measured++
      } catch (e) {
        result.failed++
        this.o.onError?.(e)
      }
    }
    try {
      result.transferred = await this.egress()
    } catch (e) {
      result.failed++
      this.o.onError?.(e)
    }
    return result
  }

  private async egress(): Promise<number> {
    const { call, secret, git } = this.o
    if (!git?.egress) return 0
    const since = this.sinceEgress
    const now = Date.now()
    let total = 0
    for (const { storeId, bytes } of await git.egress(since)) {
      if (!(bytes > 0)) continue
      await call('storeWorker:addTransfer', { secret, storeId, bytes })
      total += bytes
    }
    this.sinceEgress = now
    return total
  }

  start(everyMs = 30_000): () => void {
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      this.tick()
        .catch((e: unknown) => this.o.onError?.(e))
        .finally(() => {
          running = false
        })
    }, everyMs)
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }
}
