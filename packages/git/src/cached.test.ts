import { describe, expect, test } from 'bun:test'
import { GitError } from './types'
import { createReadCache } from './cached'
import { fakeRepo } from './fake'
import type { SharedTier } from './cached'
import type { GitRepo } from './types'

function counted(id: string) {
  const inner = fakeRepo(id)
  const calls = { total: 0 }
  const count =
    <TArgs extends Array<unknown>, TResult>(fn: (...a: TArgs) => TResult) =>
    (...a: TArgs): TResult => {
      calls.total++
      return fn(...a)
    }
  const repo: GitRepo = {
    listFiles: count(inner.listFiles.bind(inner)),
    listCommits: count(inner.listCommits.bind(inner)),
    getCommit: count(inner.getCommit.bind(inner)),
    getCommitDiff: count(inner.getCommitDiff.bind(inner)),
    getFileStream: count(inner.getFileStream.bind(inner)),
    blame: count(inner.blame.bind(inner)),
    compare: count(inner.compare.bind(inner)),
  }
  return { repo, calls, inner }
}

function clock() {
  let t = 1_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function memoryTier() {
  const rows = new Map<string, string>()
  const tier: SharedTier & { rows: typeof rows; sets: number } = {
    rows,
    sets: 0,
    get: (k) => Promise.resolve(rows.get(k) ?? null),
    set(k, v) {
      tier.sets++
      rows.set(k, v)
      return Promise.resolve()
    },
  }
  return tier
}

describe('reads addressed by a full SHA', () => {
  test('are fetched once, and never expire', async () => {
    const c = clock()
    const cache = createReadCache({ ttlMs: 1_000, now: c.now })
    const { repo, calls, inner } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    const { commits } = await inner.listCommits()
    const sha = commits[0].sha
    expect(sha).toHaveLength(40)

    const a = await cached.getCommit({ sha })
    c.advance(24 * 60 * 60 * 1000)
    const b = await cached.getCommit({ sha })
    await cached.getCommitDiff({ sha })
    await cached.getCommitDiff({ sha })
    expect(b).toEqual(a)
    expect(calls.total).toBe(2)
    expect(cache.stats.hits).toBe(2)
  })

  test('a file at a commit is read once and can be read as many times as asked', async () => {
    const cache = createReadCache()
    const { repo, calls, inner } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    const sha = (await inner.listCommits()).commits[0].sha

    const first = await cached.getFileStream({ path: 'README.md', ref: sha })
    const second = await cached.getFileStream({ path: 'README.md', ref: sha })
    expect(await first.text()).toBe(await second.text())
    expect(calls.total).toBe(1)
  })

  test('blame and compare between two commits are read once', async () => {
    const cache = createReadCache()
    const { repo, calls, inner } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    const [tip, , root] = (await inner.listCommits()).commits.map((c) => c.sha)
    for (let i = 0; i < 3; i++) {
      await cached.blame({ path: 'src/index.ts', ref: tip })
      await cached.compare({ base: root, head: tip })
    }
    expect(calls.total).toBe(2)
  })

  test('callers get their own copy: changing one result does not change the next', async () => {
    const cache = createReadCache()
    const { repo, inner } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    const sha = (await inner.listCommits()).commits[0].sha
    const a = await cached.getCommit({ sha })
    a.commit.message = 'tampered'
    expect((await cached.getCommit({ sha })).commit.message).not.toBe(
      'tampered',
    )
  })
})

describe('reads that follow a branch', () => {
  test('look the branch up once per ttl and read what is below it by commit', async () => {
    const c = clock()
    const cache = createReadCache({ headTtlMs: 1_000, now: c.now })
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)

    await cached.listFiles()
    await cached.listFiles()
    await cached.getFileStream({ path: 'README.md' })
    expect(calls.total).toBe(3)
    expect(cache.stats.resolves).toBe(1)

    c.advance(1_001)
    await cached.listFiles()
    await cached.getFileStream({ path: 'README.md' })
    expect(calls.total).toBe(4)
    expect(cache.stats.resolves).toBe(2)
  })

  test('a branch that moves reads the new commit, and the old commit stays cached', async () => {
    const c = clock()
    const cache = createReadCache({ headTtlMs: 1_000, now: c.now })
    let tip = 'a'.repeat(40)
    const listed: Array<string | undefined> = []
    const repo = {
      listCommits: () =>
        Promise.resolve({ commits: [{ sha: tip }], hasMore: false }),
      listFiles: (o?: { ref?: string }) => {
        listed.push(o?.ref)
        return Promise.resolve({
          ref: o?.ref ?? '',
          paths: [o?.ref ?? ''],
          hasMore: false,
        })
      },
    } as unknown as GitRepo
    const cached = cache.wrap('r', repo)

    expect((await cached.listFiles({ ref: 'main' })).paths).toEqual([tip])
    tip = 'b'.repeat(40)
    expect((await cached.listFiles({ ref: 'main' })).paths).toEqual([
      'a'.repeat(40),
    ])
    c.advance(1_001)
    expect((await cached.listFiles({ ref: 'main' })).paths).toEqual([tip])
    expect((await cached.listFiles({ ref: 'a'.repeat(40) })).paths).toEqual([
      'a'.repeat(40),
    ])
    expect(listed).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  })

  test('a short SHA is resolved, then its content is permanent', async () => {
    const c = clock()
    const cache = createReadCache({ headTtlMs: 1_000, now: c.now })
    const { repo, calls, inner } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    const short = (await inner.listCommits()).commits[2].sha.slice(0, 7)

    await cached.listFiles({ ref: short })
    c.advance(1_001)
    await cached.listFiles({ ref: short })
    expect(calls.total).toBe(3)
  })

  test('an unknown ref still fails like the store does, and is not remembered', async () => {
    const cache = createReadCache()
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    for (let i = 0; i < 2; i++) {
      const err = await cached
        .listFiles({ ref: 'nope' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GitError)
    }
    expect(calls.total).toBe(4)
  })

  test('invalidate forgets where branches point, for one repo, and keeps pinned reads', async () => {
    const cache = createReadCache()
    const a = counted('tinyqueue')
    const b = counted('gitfs')
    const repoA = cache.wrap('tinyqueue', a.repo)
    const repoB = cache.wrap('gitfs', b.repo)
    const sha = (await a.inner.listCommits()).commits[0].sha

    await repoA.listFiles()
    await repoA.getCommit({ sha })
    await repoB.listFiles()
    cache.invalidate('tinyqueue')

    await repoA.listFiles()
    await repoA.getCommit({ sha })
    await repoB.listFiles()
    expect(a.calls.total).toBe(4)
    expect(b.calls.total).toBe(2)
  })
})

describe('a shared tier', () => {
  test('serves what another process already read, and only by commit', async () => {
    const tier = memoryTier()
    const first = counted('tinyqueue')
    const second = counted('tinyqueue')
    const one = createReadCache({ shared: tier }).wrap('tinyqueue', first.repo)
    const two = createReadCache({ shared: tier }).wrap('tinyqueue', second.repo)
    const sha = (await first.inner.listCommits()).commits[0].sha

    const a = await one.getCommit({ sha })
    await one.getFileStream({ path: 'README.md', ref: sha })
    await one.listCommits({ branch: sha, limit: 2 })
    await new Promise((r) => setTimeout(r, 0))
    for (const key of tier.rows.keys()) expect(key).not.toContain('"main"')

    const b = await two.getCommit({ sha })
    const file = await two.getFileStream({ path: 'README.md', ref: sha })
    await two.listCommits({ branch: sha, limit: 2 })
    expect(second.calls.total).toBe(0)
    expect(b.commit.date).toBeInstanceOf(Date)
    expect(b).toEqual(a)
    expect(await file.text()).toContain('tinyqueue')
  })

  test('a tier that fails or returns junk never fails a read', async () => {
    const broken: SharedTier = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    }
    const junk: SharedTier = {
      get: () => Promise.resolve('{not json'),
      set: () => Promise.resolve(),
    }
    for (const shared of [broken, junk]) {
      const { repo, inner } = counted('tinyqueue')
      const cached = createReadCache({ shared }).wrap('tinyqueue', repo)
      const sha = (await inner.listCommits()).commits[0].sha
      expect((await cached.getCommit({ sha })).commit.sha).toBe(sha)
      expect(
        (await cached.getFileStream({ path: 'README.md', ref: sha })).ok,
      ).toBe(true)
    }
  })

  test('a missing file is not stored', async () => {
    const tier = memoryTier()
    const { repo, inner } = counted('tinyqueue')
    const cached = createReadCache({ shared: tier }).wrap('tinyqueue', repo)
    const sha = (await inner.listCommits()).commits[0].sha
    expect(
      (await cached.getFileStream({ path: 'nope', ref: sha })).status,
    ).toBe(404)
    await new Promise((r) => setTimeout(r, 0))
    expect(tier.sets).toBe(0)
  })
})

describe('sharing and failure', () => {
  test('concurrent identical reads share one call', async () => {
    const cache = createReadCache()
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    await Promise.all([
      cached.listFiles(),
      cached.listFiles(),
      cached.listFiles(),
    ])
    expect(calls.total).toBe(2)
  })

  test('a missing file is not remembered', async () => {
    const cache = createReadCache()
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    expect((await cached.getFileStream({ path: 'nope' })).status).toBe(404)
    expect((await cached.getFileStream({ path: 'nope' })).status).toBe(404)
    expect(calls.total).toBe(3)
  })

  test('an unknown commit still fails like the real SDK, and is not remembered', async () => {
    const cache = createReadCache()
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    for (let i = 0; i < 2; i++) {
      const err = await cached
        .getCommit({ sha: 'deadbeef' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GitError)
    }
    expect(calls.total).toBe(2)
  })

  test('the oldest entry goes first when the cache is full', async () => {
    const cache = createReadCache({ maxEntries: 3 })
    const { repo, calls } = counted('tinyqueue')
    const cached = cache.wrap('tinyqueue', repo)
    await cached.listCommits({ limit: 1 })
    await cached.listCommits({ limit: 2 })
    await cached.listCommits({ limit: 3 })
    await cached.listCommits({ limit: 1 })
    expect(calls.total).toBeGreaterThan(4)
  })
})

test('a page view that reads the same repo twice costs one set of store calls', async () => {
  const cache = createReadCache()
  const { repo, calls, inner } = counted('tinyqueue')
  const cached = cache.wrap('tinyqueue', repo)
  const sha = (await inner.listCommits()).commits[0].sha
  const view = () =>
    Promise.all([
      cached.listFiles({ ref: sha }),
      cached.listCommits({ branch: sha, limit: 10 }),
      cached.getFileStream({ path: 'README.md', ref: sha }),
    ])
  await view()
  const after = calls.total
  for (let i = 0; i < 20; i++) await view()
  expect(after).toBe(3)
  expect(calls.total).toBe(3)
})
