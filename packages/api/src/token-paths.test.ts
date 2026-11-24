import { describe, expect, test } from 'bun:test'
import { principalOf } from './auth'
import { outsidePaths } from './paths'
import { harness } from './testing'

/**
 * A token can name paths inside its one repository: a token for `docs/**`
 * changes nothing else, through the API, cb and MCP. A direct `git push`
 * does not carry a token, so the `allowed-paths` rule covers that path.
 */

const R = '/repos/dana/gitfs'

async function pathToken(h: ReturnType<typeof harness>, paths: Array<string>) {
  const r = await h.call('POST', '/tokens', {
    body: {
      name: `paths ${paths.join(' ')}`,
      scopes: ['repo:read', 'repo:write', 'pulls:read', 'pulls:write'],
      repos: ['dana/gitfs'],
      paths,
    },
  })
  expect(r.status).toBe(201)
  return r.json as { id: string; secret: string; paths: Array<string> }
}

describe('the glob helper', () => {
  test('uses the policy globs: src/** does not match src itself', () => {
    expect(outsidePaths(['src/a.rs', 'src/x/y.rs'], ['src/**'])).toEqual([])
    expect(outsidePaths(['src'], ['src/**'])).toEqual(['src'])
    expect(outsidePaths(['db/1.sql', 'a.sql'], ['*.sql'])).toEqual(['db/1.sql'])
    expect(outsidePaths(['db/1.sql'], ['**/*.sql'])).toEqual([])
  })
})

describe('tokens with paths', () => {
  test('are shown, and two with different paths never share answers', async () => {
    const h = harness()
    const docs = await pathToken(h, ['docs/**'])
    const src = await pathToken(h, ['src/**'])
    expect(docs.paths).toEqual(['docs/**'])
    const listed = (await h.call('GET', '/tokens')).json.data
    expect(listed.find((t: any) => t.id === docs.id).paths).toEqual(['docs/**'])
    expect(listed.every((t: any) => 'paths' in t)).toBe(true)
    // An older token has none.
    expect(
      listed.filter((t: any) => t.id !== docs.id && t.id !== src.id)[0].paths,
    ).toBeNull()
    const a = principalOf((await h.api.port.svc.auth.get(docs.id))!)
    const b = principalOf((await h.api.port.svc.auth.get(src.id))!)
    expect(a.capabilityKey).not.toBe(b.capabilityKey)
    expect(a.capId).not.toBe(b.capId)
  })

  test('need exactly one repository', async () => {
    const h = harness()
    for (const repos of [undefined, ['dana/gitfs', 'dana/tinyqueue']]) {
      const r = await h.call('POST', '/tokens', {
        body: { name: 'x', scopes: ['repo:read'], repos, paths: ['src/**'] },
      })
      expect(r.status).toBe(400)
      expect(r.json.errors[0].pointer).toBe('/body/paths')
    }
    const many = await h.call('POST', '/tokens', {
      body: {
        name: 'x',
        scopes: ['repo:read'],
        repos: ['dana/gitfs'],
        paths: Array.from({ length: 51 }, (_, i) => `d${i}/**`),
      },
    })
    expect(many.status).toBe(400)
  })

  test('a change inside the paths is made; one outside is refused', async () => {
    const h = harness()
    const src = await pathToken(h, ['src/**'])
    // A new change from a branch touches src/<branch>.rs in the sample store.
    const ok = await h.call('POST', `${R}/changes`, {
      token: src.secret,
      body: { branch: 'inside-paths' },
    })
    expect(ok.status).toBe(201)
    const docs = await pathToken(h, ['docs/**'])
    const no = await h.call('POST', `${R}/changes`, {
      token: docs.secret,
      body: { branch: 'outside-paths' },
    })
    expect(no.status).toBe(403)
    expect(no.json.code).toBe('forbidden')
    expect(no.json.detail).toContain('src/outside_paths.rs')
    expect(no.json.hint).toContain('src/outside_paths.rs')
    // Nothing was made.
    const list = (await h.call('GET', `${R}/changes?limit=50&state=all`)).json
    expect(
      list.data.some((c: any) => c.title === 'Changes from outside-paths'),
    ).toBe(false)
  })

  test('editing a file outside is refused, and so is deleting one', async () => {
    const h = harness()
    // #216 holds src/refs.rs and tests/refs_test.rs.
    const both = await pathToken(h, ['src/**', 'tests/**'])
    const src = await pathToken(h, ['src/**'])
    const edit = (token: string, files: Record<string, string | null>) =>
      h.call('POST', `${R}/changes/216/patch-sets`, {
        token,
        body: { kind: 'update', files },
      })
    expect(
      (await edit(both.secret, { 'src/refs.rs': 'pub struct Refs;\n' })).status,
    ).toBe(201)
    // The change also holds tests/: a token for src/** alone may not write it.
    const outside = await edit(src.secret, { 'src/refs.rs': 'x\n' })
    expect(outside.status).toBe(403)
    expect(outside.json.detail).toContain('tests/refs_test.rs')
    const del = await edit(both.secret, { 'tests/refs_test.rs': null })
    expect(del.status).toBe(201)
    const docsOnly = await pathToken(h, ['src/**', 'docs/**'])
    const deletion = await edit(docsOnly.secret, { 'tests/refs_test.rs': null })
    expect(deletion.status).toBe(403)
  })

  test('a token limited to paths cannot make one that reaches further', async () => {
    const h = harness()
    const r = await h.call('POST', '/tokens', {
      body: {
        name: 'manager',
        scopes: ['repo:read', 'tokens:manage'],
        repos: ['dana/gitfs'],
        paths: ['docs/**'],
      },
    })
    const wider = await h.call('POST', '/tokens', {
      token: r.json.secret,
      body: {
        name: 'wider',
        scopes: ['repo:read'],
        repos: ['dana/gitfs'],
        paths: ['src/**'],
      },
    })
    expect(wider.status).toBe(403)
    const none = await h.call('POST', '/tokens', {
      token: r.json.secret,
      body: { name: 'unlimited', scopes: ['repo:read'], repos: ['dana/gitfs'] },
    })
    expect(none.status).toBe(403)
  })
})

describe('the allowed-paths rule', () => {
  test('blocks a change touching anything else, whoever pushed it', async () => {
    const h = harness()
    const made = await h.call('POST', `${R}/policy/rules`, {
      body: {
        id: 'allowed-paths',
        name: 'Only the source',
        kind: 'allowed_paths',
        paths: ['src/**'],
      },
    })
    expect([201, 202]).toContain(made.status)
    // #216 touches src/refs.rs and tests/refs_test.rs.
    const p = (await h.call('GET', `${R}/changes/216/policy`)).json
    const req = p.requirements.find((r: any) => r.id === 'allowed-paths')
    expect(req.state).toBe('fail')
    expect(req.detail).toContain('tests/refs_test.rs')
    // A change from a branch touches only src/ in the sample store.
    const c = (
      await h.call('POST', `${R}/changes`, { body: { branch: 'only-src' } })
    ).json
    const q = (await h.call('GET', `${R}/changes/${c.number}/policy`)).json
    expect(
      q.requirements.find((r: any) => r.id === 'allowed-paths').state,
    ).toBe('pass')
  })

  test('reads from the policy file', async () => {
    const { parsePolicy } = await import('./policy-file')
    const { policyRules } = await import('./policy-builtins')
    const r = parsePolicy(
      'rules:\n  - id: docs-only\n    require:\n      - allowed_paths: ["docs/**", "*.md"]\n',
      policyRules,
    )
    expect(r.errors).toEqual([])
    expect(r.content?.custom[0]).toMatchObject({
      kind: 'allowed_paths',
      paths: ['docs/**', '*.md'],
    })
    const bad = parsePolicy(
      'rules:\n  - id: docs-only\n    require:\n      - allowed_paths: []\n',
      policyRules,
    )
    expect(bad.errors[0].message).toContain('allowed_paths')
  })
})
