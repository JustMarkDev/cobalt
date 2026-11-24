import { describe, expect, test } from 'bun:test'
import { harness } from './testing'
import type { Transport } from './webhooks'

/** A receiver that accepts everything, so creating a webhook never reaches the network. */
class OkTransport implements Transport {
  send() {
    return Promise.resolve({ status: 200, error: null, ms: 1 })
  }
}

const REPO = '/repos/dana/gitfs'

describe('renaming, editing and deleting a repository', () => {
  test('a rename moves the repository, keeps the old address working and writes an event', async () => {
    const h = harness()
    const before = (await h.call('GET', REPO)).json
    const r = await h.call('PATCH', REPO, {
      body: { name: 'gitfs-core', description: 'Renamed' },
    })
    expect(r.status).toBe(200)
    expect(r.json.full_name).toBe('dana/gitfs-core')
    expect(r.json.description).toBe('Renamed')
    expect(r.json.id).toBe(before.id)
    expect((await h.call('GET', '/repos/dana/gitfs-core')).status).toBe(200)
    // The old address redirects, with the new one in Location.
    const old = await h.call('GET', REPO)
    expect(old.status).toBe(308)
    expect(old.headers.get('location')).toContain('/repos/dana/gitfs-core')
    // What belonged to the repository went with it.
    expect(
      (await h.call('GET', '/repos/dana/gitfs-core/changes/216')).status,
    ).toBe(200)
    const events = (await h.call('GET', '/events?type=repo.*')).json.data
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      'repo.updated',
    ])
    expect(events[0].changes.sort()).toEqual(['description', 'name'])
  })

  test('webhooks follow a rename', async () => {
    const h = harness({ transport: new OkTransport() })
    const hook = await h.call('POST', `${REPO}/webhooks`, {
      body: { endpoint: 'https://hooks.example.com/cb', events: ['*'] },
    })
    expect(hook.status).toBe(201)
    await h.call('PATCH', REPO, { body: { name: 'gitfs2' } })
    const list = await h.call('GET', '/repos/dana/gitfs2/webhooks')
    expect(list.json.data.map((x: { id: string }) => x.id)).toEqual([
      hook.json.id,
    ])
  })

  test('a name that is taken is refused, and so is a bad one', async () => {
    const h = harness()
    await h.call('POST', '/repos', { body: { name: 'other' } })
    const taken = await h.call('PATCH', REPO, { body: { name: 'other' } })
    expect(taken.status).toBe(409)
    expect(taken.json.code).toBe('invalid_state')
    expect(
      (await h.call('PATCH', REPO, { body: { name: 'no spaces' } })).status,
    ).toBe(400)
  })

  test('only an admin of the account may do it, and a stale If-Match is refused', async () => {
    const h = harness()
    // hollis can write to dana/gitfs but does not administer dana's account.
    const denied = await h.call('PATCH', REPO, {
      token: h.tokens.hollis,
      body: { description: 'x' },
    })
    expect(denied.status).toBe(403)
    expect(
      (
        await h.call('DELETE', `${REPO}?confirm=dana/gitfs`, {
          token: h.tokens.hollis,
        })
      ).status,
    ).toBe(403)
    const stale = await h.call('PATCH', REPO, {
      body: { description: 'x' },
      headers: { 'if-match': '"0"' },
    })
    expect(stale.status).toBe(412)
  })

  test('a token limited to repositories cannot rename or delete', async () => {
    const h = harness()
    expect(
      (
        await h.call('PATCH', REPO, {
          token: h.tokens.limited,
          body: { name: 'z' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await h.call('DELETE', `${REPO}?confirm=dana/gitfs`, {
          token: h.tokens.limited,
        })
      ).status,
    ).toBe(403)
  })

  test('a dry run changes nothing', async () => {
    const h = harness()
    const r = await h.call('PATCH', `${REPO}?dry_run=true`, {
      body: { name: 'gone' },
    })
    expect(r.status).toBe(200)
    expect((await h.call('GET', REPO)).status).toBe(200)
    expect((await h.call('GET', '/repos/dana/gone')).status).toBe(404)
    expect(
      (await h.call('DELETE', `${REPO}?dry_run=true&confirm=dana/gitfs`))
        .status,
    ).toBe(204)
    expect((await h.call('GET', REPO)).status).toBe(200)
  })

  test('visibility changes who can see it', async () => {
    const h = harness()
    expect(
      (await h.call('GET', REPO, { token: h.tokens.stranger })).status,
    ).toBe(200)
    await h.call('PATCH', REPO, { body: { visibility: 'private' } })
    expect(
      (await h.call('GET', REPO, { token: h.tokens.stranger })).status,
    ).toBe(404)
    // And search no longer finds it for them.
    const found = await h.call('GET', '/search?q=negative', {
      token: h.tokens.stranger,
    })
    expect(found.json.data).toEqual([])
  })

  test('deleting needs the full name, then removes the repository and what hangs on it', async () => {
    const h = harness({ transport: new OkTransport() })
    await h.call('POST', `${REPO}/webhooks`, {
      body: { endpoint: 'https://hooks.example.com/cb', events: ['*'] },
    })
    const noConfirm = await h.call('DELETE', REPO)
    expect(noConfirm.status).toBe(400)
    expect(noConfirm.json.code).toBe('invalid_request')
    expect((await h.call('DELETE', `${REPO}?confirm=dana/other`)).status).toBe(
      400,
    )
    expect((await h.call('GET', REPO)).status).toBe(200)

    const ok = await h.call('DELETE', `${REPO}?confirm=dana/gitfs`)
    expect(ok.status).toBe(204)
    expect((await h.call('GET', REPO)).status).toBe(404)
    expect((await h.call('GET', `${REPO}/changes/216`)).status).toBe(404)
    expect(
      (await h.call('GET', '/events?type=repo.deleted')).json.data,
    ).toHaveLength(1)
    // The name is free again.
    const again = await h.call('POST', '/repos', { body: { name: 'gitfs' } })
    expect(again.status).toBe(201)
    expect((await h.call('GET', `${REPO}/webhooks`)).json.data).toEqual([])
    const results = (await h.call('GET', '/search?q=negative')).json
      .data as Array<{ repo: string }>
    expect(results.every((x) => x.repo !== 'dana/gitfs')).toBe(true)
  })
})

describe('asking for markdown', () => {
  const md = { accept: 'text/markdown' }

  test('a change, an issue and the start-up bundle come back as readable text', async () => {
    const h = harness()
    const change = await h.call('GET', `${REPO}/changes/216`, { headers: md })
    expect(change.status).toBe(200)
    expect(change.headers.get('content-type')).toContain('text/markdown')
    expect(change.text).toMatch(/^# #216 /)
    expect(change.text).toContain('## Policy:')
    expect(change.text).toContain('## You can')
    const json = (await h.call('GET', `${REPO}/changes/216`)).json
    // Every fact in the text is in the object it was made from.
    expect(change.text).toContain(json.title)
    expect(change.text).toContain(json.head.tree)
    expect(change.text.length).toBeLessThan(JSON.stringify(json).length)

    const issues = (await h.call('GET', `${REPO}/issues`)).json.data
    const issue = await h.call('GET', `${REPO}/issues/${issues[0].number}`, {
      headers: md,
    })
    expect(issue.text).toContain(issues[0].title)

    const ctx = await h.call('GET', `${REPO}/context`, { headers: md })
    expect(ctx.text).toMatch(/^# dana\/gitfs/)
    expect(ctx.text).toContain('## Changes')
    expect(ctx.text).toContain('/sync?repo=dana/gitfs')
  })

  test('the two forms have their own ETags and neither is served for the other', async () => {
    const h = harness()
    const j = await h.call('GET', `${REPO}/changes/216`)
    const m = await h.call('GET', `${REPO}/changes/216`, { headers: md })
    expect(j.headers.get('etag')).not.toBe(m.headers.get('etag'))
    expect(j.headers.get('vary')).toContain('accept')
    // Conditional reads work in each form, and again after the body cache is warm.
    expect(
      (
        await h.call('GET', `${REPO}/changes/216`, {
          headers: { ...md, 'if-none-match': m.headers.get('etag')! },
        })
      ).status,
    ).toBe(304)
    const again = await h.call('GET', `${REPO}/changes/216`, { headers: md })
    expect(again.text).toBe(m.text)
    expect((await h.call('GET', `${REPO}/changes/216`)).json.object).toBe(
      'change',
    )
    // An operation without a readable form answers JSON as usual.
    expect(
      (await h.call('GET', `${REPO}/changes`, { headers: md })).json.object,
    ).toBe('list')
  })

  test('errors stay problem+json whatever was asked for', async () => {
    const h = harness()
    const r = await h.call('GET', `${REPO}/changes/99999`, { headers: md })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
  })
})

describe('git data', () => {
  const G = `${REPO}/git`

  test('lists a directory, directories first, and reads a file', async () => {
    const h = harness()
    const root = await h.call('GET', `${G}/tree`)
    expect(root.status).toBe(200)
    expect(root.json.object).toBe('tree')
    expect(root.json.ref).toMatch(/^[0-9a-f]{40}$/)
    const names = root.json.entries.map((e: { name: string }) => e.name)
    expect(names).toContain('README.md')
    const kinds = root.json.entries.map((e: { type: string }) => e.type)
    // Directories come before files.
    expect(kinds.indexOf('blob')).toBeGreaterThanOrEqual(
      kinds.lastIndexOf('tree'),
    )
    const dir = root.json.entries.find(
      (e: { type: string }) => e.type === 'tree',
    )
    if (dir) {
      const inner = await h.call(
        'GET',
        `${G}/tree?path=${encodeURIComponent(dir.path)}`,
      )
      expect(
        inner.json.entries.every((e: { path: string }) =>
          e.path.startsWith(`${dir.path}/`),
        ),
      ).toBe(true)
    }
    const blob = await h.call('GET', `${G}/blob?path=README.md`)
    expect(blob.json).toMatchObject({
      object: 'blob',
      path: 'README.md',
      encoding: 'utf-8',
    })
    expect(blob.json.content.length).toBe(blob.json.size)
    expect((await h.call('GET', `${G}/blob?path=nope.txt`)).status).toBe(404)
    expect((await h.call('GET', `${G}/tree?path=nope`)).status).toBe(404)
  })

  test('history pages by the last commit sent, and a commit and its diff agree', async () => {
    const h = harness()
    const first = await h.call('GET', `${G}/commits?limit=1`)
    expect(first.json.data).toHaveLength(1)
    expect(first.json.has_more).toBe(true)
    const second = await h.call(
      'GET',
      `${G}/commits?limit=1&cursor=${first.json.next_cursor}`,
    )
    const seen = new Set(first.json.data.map((c: { sha: string }) => c.sha))
    expect(
      second.json.data.every((c: { sha: string }) => !seen.has(c.sha)),
    ).toBe(true)
    // The history is newest first: each commit's parent is the next one down.
    const all = [...first.json.data, ...second.json.data]
    expect(all[0].parents[0]).toBe(all[1].sha)

    const sha = all[0].sha
    const one = await h.call('GET', `${G}/commits/${sha}`)
    expect(one.json.message).toBe(all[0].message)
    expect(one.headers.get('cache-control')).toContain('immutable')
    const diff = await h.call('GET', `${G}/commits/${sha}/diff`)
    expect(diff.json.base_sha).toBe(all[0].parents[0])
    expect(diff.json.stats.files).toBe(diff.json.files.length)
    expect(diff.json.files[0].patch).toContain('@@')
    expect((await h.call('GET', `${G}/commits/${'0'.repeat(40)}`)).status).toBe(
      404,
    )
  })

  test('a file downloads as an attachment that cannot run in the page', async () => {
    const h = harness()
    const raw = await h.call('GET', `${G}/raw?path=README.md`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-disposition')).toContain('attachment')
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff')
    expect(raw.headers.get('content-security-policy')).toContain('sandbox')
    expect(raw.text.length).toBeGreaterThan(0)
  })

  test('recursive lists every file under a directory and no directories', async () => {
    const h = harness()
    const top = (await h.call('GET', `${G}/tree`)).json
    const all = (await h.call('GET', `${G}/tree?recursive=true`)).json
    expect(all.entries.every((e: any) => e.type === 'blob')).toBe(true)
    expect(all.entries.some((e: any) => e.path.includes('/'))).toBe(true)
    expect(all.entries.every((e: any) => e.name === e.path)).toBe(true)
    const dir = top.entries.find((e: any) => e.type === 'tree')
    const under = (
      await h.call('GET', `${G}/tree?recursive=true&path=${dir.path}`)
    ).json
    expect(under.entries.length).toBeGreaterThan(0)
    expect(
      under.entries.every((e: any) => e.path.startsWith(`${dir.path}/`)),
    ).toBe(true)
    expect((await h.call('GET', `${G}/tree?recursive=yes`)).status).toBe(400)
  })

  test('a private repository answers 404 to people who cannot read it', async () => {
    const h = harness()
    expect(
      (
        await h.call('GET', '/repos/dana/notes/git/tree', {
          token: h.tokens.stranger,
        })
      ).status,
    ).toBe(404)
    expect(
      (await h.call('GET', '/repos/dana/notes/git/commits', { token: null }))
        .status,
    ).toBe(404)
  })

  test('a repository with no history answers 404, not an error', async () => {
    const h = harness()
    await h.call('POST', '/repos', { body: { name: 'empty' } })
    expect((await h.call('GET', '/repos/dana/empty/git/tree')).status).toBe(404)
  })

  test('a case-only rename keeps git data', async () => {
    const h = harness()
    expect(
      (await h.call('PATCH', '/repos/dana/gitfs', { body: { name: 'GitFS' } }))
        .status,
    ).toBe(200)
    expect((await h.call('GET', '/repos/dana/GitFS/git/tree')).status).toBe(200)
  })

  test('two seeds with the same name get separate git stores', async () => {
    const h = harness({
      seed: (d) => {
        d.seedRepo('alice', 'same', { storeId: 'gitfs' })
        d.seedRepo('bob', 'same')
      },
    })
    expect((await h.call('GET', '/repos/alice/same/git/tree')).status).toBe(200)
    expect((await h.call('GET', '/repos/bob/same/git/tree')).status).toBe(404)
  })

  test('git follows a rename and cannot be inherited by a reused name', async () => {
    const h = harness()
    await h.call('PATCH', REPO, { body: { name: 'gitfs2' } })
    expect((await h.call('GET', '/repos/dana/gitfs/git/tree')).status).toBe(308)
    expect((await h.call('GET', '/repos/dana/gitfs2/git/tree')).status).toBe(
      200,
    )
    await h.call('DELETE', '/repos/dana/gitfs2?confirm=dana/gitfs2')
    await h.call('POST', '/repos', {
      body: { owner: 'dana', name: 'gitfs2', visibility: 'private' },
    })
    expect((await h.call('GET', '/repos/dana/gitfs2/git/tree')).status).toBe(
      404,
    )
    await h.call('POST', '/repos', {
      body: { owner: 'northwind', name: 'tinyqueue' },
    })
    expect(
      (await h.call('GET', '/repos/northwind/tinyqueue/git/tree')).status,
    ).toBe(404)
  })
})

describe('teams', () => {
  const ORG = '/accounts/northwind/teams'

  async function withVault() {
    const h = harness()
    const made = await h.call('POST', '/repos', {
      body: { owner: 'northwind', name: 'vault', visibility: 'private' },
    })
    expect(made.status).toBe(201)
    return h
  }

  test('only owners and admins make teams; outsiders cannot even see that the organization has any', async () => {
    const h = await withVault()
    expect(
      (
        await h.call('POST', ORG, {
          token: h.tokens.hollis,
          body: { slug: 'readers' },
        })
      ).status,
    ).toBe(403)
    expect(
      (await h.call('GET', ORG, { token: h.tokens.stranger })).status,
    ).toBe(404)
    expect((await h.call('GET', '/accounts/dana/teams')).status).toBe(404)
    const made = await h.call('POST', ORG, {
      body: { slug: 'readers', name: 'Readers' },
    })
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      object: 'team',
      slug: 'readers',
      members: [],
      repos: [],
    })
    const again = await h.call('POST', ORG, { body: { slug: 'readers' } })
    expect(again.status).toBe(200)
    expect(again.headers.get('cb-outcome')).toBe('unchanged')
    expect(
      (await h.call('GET', ORG, { token: h.tokens.hollis })).json.data,
    ).toHaveLength(1)
    expect(
      (await h.call('POST', ORG, { body: { slug: 'Bad Slug' } })).status,
    ).toBe(400)
  })

  test('a team gives people outside the organization read or write access to the repositories it is given', async () => {
    const h = await withVault()
    await h.call('POST', ORG, { body: { slug: 'readers' } })
    const vault = '/repos/northwind/vault'
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(404)

    await h.call('PUT', `${ORG}/readers/members/stranger`)
    // A member of a team with no repositories still sees nothing.
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(404)
    const given = await h.call('PUT', `${ORG}/readers/repos/northwind/vault`, {
      body: { permission: 'read' },
    })
    expect(given.json.repos).toEqual([
      { full_name: 'northwind/vault', permission: 'read' },
    ])
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(200)
    expect(
      (
        await h.call('POST', `${vault}/issues`, {
          token: h.tokens.stranger,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(403)

    await h.call('PUT', `${ORG}/readers/repos/northwind/vault`, {
      body: { permission: 'write' },
    })
    expect(
      (
        await h.call('POST', `${vault}/issues`, {
          token: h.tokens.stranger,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(201)

    // Taking the person out, or the team away, takes the access with it.
    await h.call('DELETE', `${ORG}/readers/members/stranger`)
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(404)
    await h.call('PUT', `${ORG}/readers/members/stranger`)
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(200)
    expect((await h.call('DELETE', `${ORG}/readers`)).status).toBe(204)
    expect(
      (await h.call('GET', vault, { token: h.tokens.stranger })).status,
    ).toBe(404)
  })

  test('a dry run shows team member and repository changes', async () => {
    const h = await withVault()
    await h.call('POST', ORG, { body: { slug: 'dry' } })
    const member = await h.call(
      'PUT',
      `${ORG}/dry/members/stranger?dry_run=true`,
    )
    expect(member.json.members).toContain('stranger')
    expect((await h.call('GET', `${ORG}/dry`)).json.members).toEqual([])
    const repo = await h.call(
      'PUT',
      `${ORG}/dry/repos/northwind/vault?dry_run=true`,
      { body: { permission: 'write' } },
    )
    expect(repo.json.repos).toEqual([
      { full_name: 'northwind/vault', permission: 'write' },
    ])
    expect((await h.call('GET', `${ORG}/dry`)).json.repos).toEqual([])
  })

  test('a team reaches only its own organization, and the grant follows a rename', async () => {
    const h = await withVault()
    await h.call('POST', ORG, { body: { slug: 'readers' } })
    const other = await h.call('PUT', `${ORG}/readers/repos/dana/gitfs`, {
      body: { permission: 'read' },
    })
    expect(other.status).toBe(400)
    await h.call('PUT', `${ORG}/readers/members/stranger`)
    await h.call('PUT', `${ORG}/readers/repos/northwind/vault`, {
      body: { permission: 'read' },
    })
    await h.call('PATCH', '/repos/northwind/vault', { body: { name: 'safe' } })
    expect(
      (await h.call('GET', `${ORG}/readers`)).json.repos[0].full_name,
    ).toBe('northwind/safe')
    expect(
      (
        await h.call('GET', '/repos/northwind/safe', {
          token: h.tokens.stranger,
        })
      ).status,
    ).toBe(200)
    await h.call('DELETE', '/repos/northwind/safe?confirm=northwind/safe')
    expect((await h.call('GET', `${ORG}/readers`)).json.repos).toEqual([])
  })

  test('edits need the current version, and unknown people and teams are 404', async () => {
    const h = await withVault()
    await h.call('POST', ORG, { body: { slug: 'readers' } })
    expect(
      (
        await h.call('PATCH', `${ORG}/readers`, {
          body: { name: 'R' },
          headers: { 'if-match': '"99"' },
        })
      ).status,
    ).toBe(412)
    const t = await h.call('GET', `${ORG}/readers`)
    const etag = t.headers.get('etag')!
    const ok = await h.call('PATCH', `${ORG}/readers`, {
      body: { name: 'R' },
      headers: { 'if-match': etag },
    })
    expect(ok.json.name).toBe('R')
    expect((await h.call('PUT', `${ORG}/readers/members/nobody`)).status).toBe(
      404,
    )
    expect((await h.call('GET', `${ORG}/missing`)).status).toBe(404)
    expect(
      (await h.call('DELETE', `${ORG}/readers/members/stranger`)).status,
    ).toBe(404)
  })
})

describe('the sample API clock', () => {
  test('a token minted long after start is not born expired', async () => {
    const { createSampleApi } = await import('./index')
    let t = Date.parse('2026-11-13T09:00:00Z')
    const api = createSampleApi({ now: () => t })
    t += 60 * 60_000
    const { record } = await api.domain.svc.auth.create({
      name: 'later',
      kind: 'personal',
      handle: 'dana',
      scopes: ['repo:read'],
      ttlMs: 10 * 60_000,
    })
    expect(record.expiresAt).toBe(t + 10 * 60_000)
  })
})

describe('a transfer to another account', () => {
  test("the old owner's webhooks do not follow the repository", async () => {
    const h = harness({ transport: new OkTransport() })
    const hook = await h.call('POST', `${REPO}/webhooks`, {
      body: { endpoint: 'https://hooks.example.com/cb', events: ['*'] },
    })
    expect(hook.status).toBe(201)
    await h.call('POST', `${REPO}/transfer`, {
      body: { owner: 'northwind', confirm: 'dana/gitfs' },
    })
    const list = await h.call('GET', '/repos/northwind/gitfs/webhooks')
    expect(list.json.data).toEqual([])
  })
})
