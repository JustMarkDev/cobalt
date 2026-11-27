import { describe, expect, test } from 'bun:test'
import * as S from './schemas'
import type { GitRepo } from '@cobaltforge/git'
import { asPerson, harness } from './testing'

const R = '/repos/dana/gitfs'

async function shas(h: ReturnType<typeof harness>) {
  const commits = (await h.call('GET', `${R}/git/commits?limit=100`)).json.data
  return commits.map((c: { sha: string }) => c.sha) as Array<string>
}

describe('git.blame', () => {
  test('names the commit behind each line, and a range cuts it', async () => {
    const h = harness()
    const tip = (await shas(h))[0]
    const r = await h.call('GET', `${R}/git/blame?path=src/refs.rs`)
    expect(r.status).toBe(200)
    expect(S.GitBlame.safeParse(r.json).success).toBe(true)
    expect(r.json.ref).toBe(tip)
    const lines = r.json.lines as Array<{ line: number; summary: string }>
    expect(lines.length).toBeGreaterThan(5)
    // `pub struct Refs {` predates the negative cache; the neg field is new.
    expect(lines[0].summary).toBe('Project skeleton')
    expect(lines.find((l) => l.line === 3)?.summary).toBe(
      'Cache negative ref lookups',
    )
    expect(r.json.has_more).toBe(false)

    const part = await h.call(
      'GET',
      `${R}/git/blame?path=src/refs.rs&from=2&to=3`,
    )
    expect(part.json.lines.map((l: { line: number }) => l.line)).toEqual([2, 3])
    expect(
      (await h.call('GET', `${R}/git/blame?path=src/refs.rs&from=3&to=2`))
        .status,
    ).toBe(400)
  })

  test('a commit id is cacheable for good, a branch is not', async () => {
    const h = harness()
    const tip = (await shas(h))[0]
    const pinned = await h.call(
      'GET',
      `${R}/git/blame?path=src/refs.rs&ref=${tip}`,
    )
    expect(pinned.headers.get('cache-control')).toContain('immutable')
    const moving = await h.call('GET', `${R}/git/blame?path=src/refs.rs`)
    expect(moving.headers.get('cache-control')).not.toContain('immutable')
  })

  test('a missing file is a 404, and a private file is too', async () => {
    const h = harness()
    expect((await h.call('GET', `${R}/git/blame?path=nope.rs`)).status).toBe(
      404,
    )
    const rule = await h.call('PUT', `${R}/access-rules/refs`, {
      body: { kind: 'path', patterns: ['src/refs.rs'], readers: ['ines'] },
    })
    expect(rule.status).toBe(201)
    const url = `${R}/git/blame?path=src/refs.rs`
    expect((await asPerson(h, 'ines', 'GET', url)).status).toBe(200)
    expect((await asPerson(h, 'hollis', 'GET', url)).status).toBe(404)
  })
})

describe('git.compare', () => {
  test('gives the merge base and what head changed since', async () => {
    const h = harness()
    const all = await shas(h)
    const tip = all[0]
    const root = all.at(-1)!
    const r = await h.call('GET', `${R}/git/compare?base=${root}&head=${tip}`)
    expect(r.status).toBe(200)
    expect(S.GitCompare.safeParse(r.json).success).toBe(true)
    expect(r.json.merge_base).toBe(root)
    expect(r.json.head).toBe(tip)
    expect(r.json.files.length).toBeGreaterThan(0)
    expect(r.json.stats.files).toBe(r.json.files.length)
    expect(r.headers.get('cache-control')).toContain('immutable')

    const narrow = await h.call(
      'GET',
      `${R}/git/compare?base=${root}&head=${tip}&path=src`,
    )
    expect(
      narrow.json.files.every((f: { path: string }) =>
        f.path.startsWith('src/'),
      ),
    ).toBe(true)

    const behind = await h.call(
      'GET',
      `${R}/git/compare?base=${tip}&head=${all[1]}`,
    )
    expect(behind.json.merge_base).toBe(all[1])
    expect(behind.json.files).toEqual([])
  })

  test('refuses what it cannot find, and what is private is not listed', async () => {
    const h = harness()
    const [tip, , , , root] = await shas(h)
    expect(
      (await h.call('GET', `${R}/git/compare?base=nope&head=${tip}`)).status,
    ).toBe(404)
    expect((await h.call('GET', `${R}/git/compare?base=${root}`)).status).toBe(
      400,
    )
    const open = (
      await h.call('GET', `${R}/git/compare?base=${root}&head=${tip}`)
    ).json
    const hidden = open.files[0].path as string
    await h.call('PUT', `${R}/access-rules/one`, {
      body: { kind: 'path', patterns: [hidden], readers: ['ines'] },
    })
    const theirs = (
      await asPerson(
        h,
        'hollis',
        'GET',
        `${R}/git/compare?base=${root}&head=${tip}`,
      )
    ).json
    expect(theirs.files.some((f: { path: string }) => f.path === hidden)).toBe(
      false,
    )
    expect(theirs.stats.files).toBe(open.stats.files - 1)
  })
})

describe('git.commits with a path or a ref', () => {
  test('follows one file through history', async () => {
    const h = harness()
    const all = await shas(h)
    const some = await h.call('GET', `${R}/git/commits?path=src/refs.rs`)
    expect(some.status).toBe(200)
    expect(some.json.data.map((c: { message: string }) => c.message)).toEqual([
      'Cache negative ref lookups',
      'Move ref lookup into Refs',
      'Project skeleton',
    ])
    expect(all.length).toBeGreaterThan(some.json.data.length)

    const older = await h.call('GET', `${R}/git/commits?ref=${all[3]}&limit=1`)
    expect(older.json.data[0].sha).toBe(all[3])
    expect(older.json.has_more).toBe(true)
    const next = await h.call(
      'GET',
      `${R}/git/commits?ref=${all[3]}&limit=1&cursor=${older.json.next_cursor}`,
    )
    expect(next.json.data[0].sha).toBe(all[4])
  })

  test('a cursor from one path is refused on another', async () => {
    const h = harness()
    const page = await h.call('GET', `${R}/git/commits?limit=1`)
    const r = await h.call(
      'GET',
      `${R}/git/commits?limit=1&path=README.md&cursor=${page.json.next_cursor}`,
    )
    expect(r.status).toBe(400)
  })

  test('a private path has no history to show', async () => {
    const h = harness()
    await h.call('PUT', `${R}/access-rules/refs`, {
      body: { kind: 'path', patterns: ['src/refs.rs'], readers: ['ines'] },
    })
    const url = `${R}/git/commits?path=src/refs.rs`
    expect((await asPerson(h, 'ines', 'GET', url)).status).toBe(200)
    expect((await asPerson(h, 'hollis', 'GET', url)).status).toBe(404)
  })
})

describe('provenance reads the store blame', () => {
  test('names the commit that wrote a line, with no walk through history', async () => {
    const h = harness()
    const r = await h.call('GET', `${R}/provenance?path=src/refs.rs&line=1`)
    expect(r.status).toBe(200)
    expect(r.json.commit.message).toBe('Project skeleton')
    const neg = await h.call('GET', `${R}/provenance?path=src/refs.rs&line=3`)
    expect(neg.json.commit.message).toBe('Cache negative ref lookups')
    const past = await h.call(
      'GET',
      `${R}/provenance?path=src/refs.rs&line=999`,
    )
    expect(past.status).toBe(400)
  })
})

describe('a push makes the read cache forget where branches point', () => {
  test('only for that repository, and only for a push', async () => {
    const { EventLog } = await import('./events')
    const { invalidateOnPush, StoreGit } = await import('./git')
    const { getFakeGitRepo } = await import('@cobaltforge/git/fake')
    const events = new EventLog()
    const git = new StoreGit(getFakeGitRepo)
    git.setRepo('dana/gitfs', 'store-1')
    const forgotten: Array<string> = []
    const off = invalidateOnPush(events, git, (id) => forgotten.push(id))
    const emit = (type: string, repo: string | null) =>
      events.append({
        type,
        repo,
        repo_id: null,
        actor: { object: 'actor', id: 'a', handle: 'dana' },
        via: null,
        subject: { object: 'repo', id: 'r', number: null },
        changes: [],
        data: null,
      })
    emit('issue.created', 'dana/gitfs')
    emit('repository.pushed', 'dana/unknown')
    emit('repository.pushed', null)
    expect(forgotten).toEqual([])
    emit('repository.pushed', 'dana/gitfs')
    expect(forgotten).toEqual(['store-1'])
    off()
    emit('repository.pushed', 'dana/gitfs')
    expect(forgotten).toEqual(['store-1'])
  })
})

describe('a listing of many pages is put together once per commit', () => {
  const sha = (c: string) => c.repeat(40)
  function paged(tip: { sha: string }) {
    const calls: Array<{ ref?: string; cursor?: string }> = []
    const store = {
      listFiles: (o?: { ref?: string; cursor?: string }) => {
        calls.push({ ref: o?.ref, cursor: o?.cursor })
        const at = FULL(o?.ref) ? o!.ref! : tip.sha
        const page = o?.cursor ? Number(o.cursor) : 0
        return Promise.resolve({
          ref: at,
          paths: [`${at.slice(0, 1)}/p${page}a`, `${at.slice(0, 1)}/p${page}b`],
          hasMore: page < 2,
          ...(page < 2 ? { nextCursor: String(page + 1) } : {}),
        })
      },
    } as unknown as GitRepo
    return { calls, store }
  }
  const FULL = (r?: string) => !!r && /^[0-9a-f]{40}$/.test(r)

  test('later pages read the commit the first page answered for, and a repeat reads nothing', async () => {
    const { StoreGit } = await import('./git')
    const tip = { sha: sha('a') }
    const { calls, store } = paged(tip)
    const git = new StoreGit(() => store)
    git.setRepo('dana/gitfs', 's')

    const first = await git.files('dana/gitfs', 'main')
    expect(first.complete).toBe(true)
    expect(first.ref).toBe(sha('a'))
    expect(first.paths).toHaveLength(6)
    // The branch moves while the pages are read: they stay one listing.
    expect(calls.map((c) => c.ref)).toEqual(['main', sha('a'), sha('a')])
    expect(new Set(first.paths.map((p) => p[0]))).toEqual(new Set(['a']))

    calls.length = 0
    tip.sha = sha('b')
    const again = await git.files('dana/gitfs', sha('a'))
    expect(again.paths).toEqual(first.paths)
    // One page to learn what commit it is; the other two come from memory.
    expect(calls).toHaveLength(1)

    // A caller changing its copy does not change the next one.
    again.paths.length = 0
    expect((await git.files('dana/gitfs', sha('a'))).paths).toHaveLength(6)

    const moved = await git.files('dana/gitfs', 'main')
    expect(moved.ref).toBe(sha('b'))
    expect(moved.paths.every((p) => p.startsWith('b/'))).toBe(true)
  })

  test('a ref that did not resolve to a commit is read again each time', async () => {
    const { StoreGit } = await import('./git')
    let reads = 0
    const store = {
      listFiles: (o?: { cursor?: string }) => {
        reads++
        const page = o?.cursor ? Number(o.cursor) : 0
        return Promise.resolve({
          ref: 'main',
          paths: [`p${page}`],
          hasMore: page < 1,
          ...(page < 1 ? { nextCursor: '1' } : {}),
        })
      },
    } as unknown as GitRepo
    const git = new StoreGit(() => store)
    git.setRepo('dana/gitfs', 's')
    await git.files('dana/gitfs', 'main')
    await git.files('dana/gitfs', 'main')
    expect(reads).toBe(4)
  })
})
