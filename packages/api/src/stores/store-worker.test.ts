import { describe, expect, test } from 'bun:test'
import { MemoryGitAdmin } from '@cobaltforge/git/admin'
import { MemoryBlobStore } from '../uploads'
import { StoreWorker } from './store-worker'
import type { ConvexCall } from './convex'

/** A Convex that holds the queue in an array and records what it is told. */
function fakeConvex(
  sweeps: Array<{ id: string; kind: 'git' | 'blob'; key: string }>,
  measure: Array<string> = [],
) {
  const log: Array<[string, Record<string, unknown>]> = []
  const call: ConvexCall = (name, args) => {
    log.push([name, args])
    if (name === 'storeWorker:claim') {
      const kinds = args.kinds as Array<string>
      return Promise.resolve({
        sweeps: sweeps.filter((s) => kinds.includes(s.kind)),
        measure: args.measure ? measure : [],
      })
    }
    return Promise.resolve(null)
  }
  return { call, log }
}

describe('the store worker', () => {
  test('deletes git stores and files, then takes them off the queue', async () => {
    const git = new MemoryGitAdmin()
    git.stores.set('store_1', 10)
    const blobs = new MemoryBlobStore()
    blobs.put('upl_1', new Uint8Array(4))
    const { call, log } = fakeConvex([
      { id: 's1', kind: 'git', key: 'store_1' },
      { id: 's2', kind: 'blob', key: 'upl_1' },
    ])
    const r = await new StoreWorker({
      call,
      secret: 'x'.repeat(16),
      git,
      blobs,
    }).tick()
    expect(r).toMatchObject({ deleted: 2, failed: 0 })
    expect(git.deleted).toEqual(['store_1'])
    expect(blobs.get('upl_1')).toBeNull()
    expect(log.find(([n]) => n === 'storeWorker:done')?.[1].ids).toEqual([
      's1',
      's2',
    ])
  })

  test('a deletion that fails stays queued, and the others go on', async () => {
    const git = new MemoryGitAdmin()
    git.deleteStore = (id: string) =>
      id === 'bad' ? Promise.reject(new Error('503')) : Promise.resolve()
    const errors: Array<unknown> = []
    const { call, log } = fakeConvex([
      { id: 's1', kind: 'git', key: 'bad' },
      { id: 's2', kind: 'git', key: 'good' },
    ])
    const r = await new StoreWorker({
      call,
      secret: 'x'.repeat(16),
      git,
      onError: (e) => errors.push(e),
    }).tick()
    expect(r).toMatchObject({ deleted: 1, failed: 1 })
    expect(errors).toHaveLength(1)
    expect(log.find(([n]) => n === 'storeWorker:done')?.[1].ids).toEqual(['s2'])
  })

  test('without code.storage it asks for no git work and measures nothing', async () => {
    const { call, log } = fakeConvex([])
    await new StoreWorker({
      call,
      secret: 'x'.repeat(16),
      blobs: new MemoryBlobStore(),
    }).tick()
    expect(log[0][1]).toMatchObject({ kinds: ['blob'], measure: false })
  })

  test('measures what was pushed to, and reports the transfer once', async () => {
    const git = new MemoryGitAdmin()
    git.stores.set('store_1', 123)
    git.out.set('store_1', 4096)
    const { call, log } = fakeConvex([], ['store_1'])
    const w = new StoreWorker({ call, secret: 'x'.repeat(16), git })
    expect(await w.tick()).toMatchObject({ measured: 1, transferred: 4096 })
    expect(
      log.find(([n]) => n === 'storeWorker:reportSize')?.[1],
    ).toMatchObject({
      storeId: 'store_1',
      bytes: 123,
    })
    expect(
      log.find(([n]) => n === 'storeWorker:addTransfer')?.[1],
    ).toMatchObject({
      bytes: 4096,
    })
    // The same window is not reported again.
    expect((await w.tick()).transferred).toBe(0)
  })
})
