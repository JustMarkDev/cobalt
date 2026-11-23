import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { asPerson, harness } from './testing'

/**
 * Access rules: branches and paths only some people may see, in a repository
 * many people read. dana owns dana/gitfs; hollis and ines collaborate on it;
 * it is public, so anyone can read the rest.
 */

const R = '/repos/dana/gitfs'

async function rule(
  h: ReturnType<typeof harness>,
  id: string,
  body: Record<string, unknown>,
) {
  const r = await h.call('PUT', `${R}/access-rules/${id}`, { body })
  expect(r.status).toBe(201)
  return r.json
}

describe('who writes and reads the rules', () => {
  test('only an owner or admin writes them; a rule cannot hide the default branch', async () => {
    const h = harness()
    const ines = await asPerson(h, 'ines', 'PUT', `${R}/access-rules/x`, {
      kind: 'branch',
      patterns: ['secret/*'],
      readers: ['ines'],
    })
    expect(ines.status).toBe(403)
    const main = await h.call('PUT', `${R}/access-rules/all`, {
      body: { kind: 'branch', patterns: ['*'], readers: ['hollis'] },
    })
    expect(main.status).toBe(400)
    expect(main.json.errors[0].pointer).toBe('/body/patterns/0')
    const nobody = await h.call('PUT', `${R}/access-rules/x`, {
      body: { kind: 'branch', patterns: ['secret/*'], readers: ['no-such'] },
    })
    expect(nobody.status).toBe(400)
  })

  test('an admin sees every rule; a reader the ones naming them; others none', async () => {
    const h = harness()
    await rule(h, 'deal', {
      kind: 'branch',
      patterns: ['deal/*'],
      readers: ['hollis'],
    })
    expect((await h.call('GET', `${R}/access-rules`)).json.data).toHaveLength(1)
    expect(
      (await asPerson(h, 'hollis', 'GET', `${R}/access-rules`)).json.data[0].id,
    ).toBe('deal')
    expect(
      (await asPerson(h, 'ines', 'GET', `${R}/access-rules`)).json.data,
    ).toEqual([])
    expect((await h.call('DELETE', `${R}/access-rules/deal`)).status).toBe(204)
    expect((await h.call('GET', `${R}/access-rules`)).json.data).toEqual([])
  })
})

describe('a private branch', () => {
  test('its changes are seen by its readers and administrators only', async () => {
    const h = harness()
    await rule(h, 'deal', {
      kind: 'branch',
      patterns: ['deal/*'],
      readers: ['hollis'],
    })
    const c = (
      await h.call('POST', `${R}/changes`, {
        body: { branch: 'deal/acme', title: 'Acquire Acme' },
      })
    ).json
    const path = `${R}/changes/${c.number}`
    expect((await h.call('GET', path)).status).toBe(200)
    expect((await asPerson(h, 'hollis', 'GET', path)).status).toBe(200)
    // A collaborator not named, and a stranger reading a public repository.
    expect((await asPerson(h, 'ines', 'GET', path)).status).toBe(404)
    expect((await h.call('GET', path, { token: null })).status).toBe(404)
    const listed = (
      await asPerson(h, 'ines', 'GET', `${R}/changes?state=all&limit=100`)
    ).json.data
    expect(listed.some((x: any) => x.number === c.number)).toBe(false)
    // Nor in the event feed, search or a sync.
    const events = (
      await asPerson(h, 'ines', 'GET', '/events?repo=dana/gitfs&limit=200')
    ).json.data
    expect(JSON.stringify(events)).not.toContain('Acquire Acme')
    const found = (await asPerson(h, 'ines', 'GET', '/search?q=Acquire')).json
      .data
    expect(found.some((x: any) => x.number === c.number)).toBe(false)
    expect(
      (await asPerson(h, 'hollis', 'GET', '/search?q=Acquire')).json.data.some(
        (x: any) => x.number === c.number,
      ),
    ).toBe(true)
    const sync = (
      await asPerson(h, 'ines', 'GET', '/sync?repo=dana/gitfs&limit=200')
    ).json
    expect(JSON.stringify(sync)).not.toContain('Acquire Acme')
    // And she cannot open a change on such a branch.
    const opened = await asPerson(h, 'ines', 'POST', `${R}/changes`, {
      branch: 'deal/beta',
    })
    expect(opened.status).toBe(403)
  })

  test('nobody is told about it who cannot see it', async () => {
    const h = harness()
    await rule(h, 'deal', {
      kind: 'branch',
      patterns: ['deal/*'],
      readers: ['hollis'],
    })
    const c = (
      await h.call('POST', `${R}/changes`, { body: { branch: 'deal/acme' } })
    ).json
    await h.call('POST', `${R}/changes/${c.number}/comments`, {
      body: { body: '@ines @hollis have a look' },
    })
    const told = async (who: string) =>
      (await asPerson(h, who, 'GET', '/notifications?kind=mention')).json.data
    expect((await told('hollis')).length).toBeGreaterThan(0)
    expect(await told('ines')).toEqual([])
  })
})

describe('a private path', () => {
  test('its files and every change touching them are hidden from everyone else', async () => {
    const h = harness()
    // #216 touches src/refs.rs and tests/refs_test.rs.
    await rule(h, 'tests', {
      kind: 'path',
      patterns: ['tests/**'],
      readers: ['ines'],
    })
    expect((await h.call('GET', `${R}/changes/216`)).status).toBe(200)
    expect((await asPerson(h, 'ines', 'GET', `${R}/changes/216`)).status).toBe(
      200,
    )
    expect(
      (await asPerson(h, 'hollis', 'GET', `${R}/changes/216`)).status,
    ).toBe(404)
    expect(
      (
        await h.call('GET', `${R}/changes/216`, {
          token: sampleTokens.hollis,
        })
      ).status,
    ).toBe(404)
  })

  test("the repository's files answer as if the path were not there", async () => {
    const h = harness()
    const tree = (await h.call('GET', `${R}/git/tree?recursive=true`)).json
    const file = tree.entries.find((e: any) => e.type === 'blob').path as string
    await rule(h, 'one', { kind: 'path', patterns: [file], readers: ['ines'] })
    const blob = `${R}/git/blob?path=${encodeURIComponent(file)}`
    expect((await h.call('GET', blob)).status).toBe(200)
    expect((await asPerson(h, 'ines', 'GET', blob)).status).toBe(200)
    expect((await asPerson(h, 'hollis', 'GET', blob)).status).toBe(404)
    expect((await h.call('GET', blob, { token: null })).status).toBe(404)
    const raw = `${R}/git/raw?path=${encodeURIComponent(file)}`
    expect((await h.call('GET', raw, { token: null })).status).toBe(404)
    const theirs = (
      await asPerson(h, 'hollis', 'GET', `${R}/git/tree?recursive=true`)
    ).json
    expect(theirs.entries.some((e: any) => e.path === file)).toBe(false)
    expect(theirs.entries.length).toBe(tree.entries.length - 1)
  })

  test('someone who does not read it cannot change it', async () => {
    const h = harness()
    await rule(h, 'src', {
      kind: 'path',
      patterns: ['src/**'],
      readers: ['dana'],
    })
    // A change from a branch touches src/<branch>.rs in the sample store.
    const r = await asPerson(h, 'ines', 'POST', `${R}/changes`, {
      branch: 'touch-src',
    })
    expect(r.status).toBe(403)
    expect(r.json.detail).toContain('private')
  })
})
