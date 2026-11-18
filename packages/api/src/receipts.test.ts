import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { harness, onConvex } from './testing'
import { DEFAULT_LANDING } from './policy-file'
import { isSensitivePath } from './sensitive'

const R = '/repos/dana/gitfs'
const AGENT = { 'sx-tool': 'T3 Code', 'sx-model': 'Claude Opus 5.5' }

describe('every write keeps a receipt', () => {
  test('the machine of the login, and the tool and model it declared', async () => {
    const h = harness()
    const c = await h.call('POST', `${R}/changes`, {
      token: sampleTokens.scoped,
      body: { branch: 'receipt-1' },
      headers: AGENT,
    })
    expect(c.status).toBe(201)
    expect(c.json.author.handle).toBe('dana')
    expect(c.json.author).not.toHaveProperty('class')
    expect(c.json.head.via).toEqual({
      machine: 'Laptop',
      tool: 'T3 Code',
      model: 'Claude Opus 5.5',
    })
    const events = (await h.call('GET', `/events?repo=dana/gitfs&limit=5`)).json
      .data
    expect(events.at(-1).via).toEqual(c.json.head.via)
  })

  test('a declared label that is not plain text is dropped, not stored', async () => {
    const h = harness()
    const c = await h.call('POST', `${R}/changes`, {
      body: { branch: 'receipt-2' },
      headers: {
        'sx-tool': '<img src=x onerror=alert(1)>',
        'sx-model': 'x'.repeat(81),
      },
    })
    expect(c.json.head.via.tool).toBeNull()
    expect(c.json.head.via.model).toBeNull()
  })

  test('nothing marks a person apart from an agent: one kind of account', async () => {
    const h = harness()
    const me = await h.call('GET', '/auth/principal', {
      token: sampleTokens.scoped,
    })
    expect(me.json).not.toHaveProperty('class')
    expect(me.json.device).toBe('Laptop')
  })
})

describe('what a repository takes', () => {
  test('a change declared with a declined model is refused; others are not', async () => {
    const h = harness()
    const set = await h.call('PATCH', R, {
      body: { declined_models: ['Claude Haiku 5.5'] },
    })
    expect(set.json.declined_models).toEqual(['Claude Haiku 5.5'])
    const weak = await h.call('POST', `${R}/changes`, {
      body: { branch: 'weak' },
      headers: { 'sx-model': 'claude haiku 5.5' },
    })
    expect(weak.status).toBe(403)
    expect(weak.json.code).toBe('model_declined')
    const strong = await h.call('POST', `${R}/changes`, {
      body: { branch: 'strong' },
      headers: AGENT,
    })
    expect(strong.status).toBe(201)
  })

  test('a denounced account opens neither changes nor issues', async () => {
    const h = harness()
    await h.call('PATCH', R, {
      body: { denounced: [{ handle: 'dana', reason: 'testing the rule' }] },
    })
    const c = await h.call('POST', `${R}/changes`, { body: { branch: 'no' } })
    expect(c.status).toBe(403)
    expect(c.json.code).toBe('denounced')
    expect(c.json.detail).toContain('testing the rule')
    const i = await h.call('POST', `${R}/issues`, { body: { title: 'no' } })
    expect(i.json.code).toBe('denounced')
  })

  test('vouched accounts are kept on the repository', async () => {
    const h = harness()
    const r = await h.call('GET', R)
    expect(r.json.vouched).toEqual(['hollis', 'ines'])
    const set = await h.call('PATCH', R, { body: { vouched: ['Kofi'] } })
    expect(set.json.vouched).toEqual(['kofi'])
  })
})

describe('landing on evidence', () => {
  test('green checks and no open high finding are enough; an approval is shown, not required', async () => {
    const h = harness()
    const c = await h.call('POST', `${R}/changes`, {
      body: { branch: 'evidence' },
    })
    const tree = c.json.head.tree
    const before = await h.call('GET', `${R}/changes/${c.json.number}/policy`)
    const reviewed = before.json.requirements.find(
      (r: { id: string }) => r.id === 'reviewed',
    )
    expect(reviewed.state).toBe('na')
    expect(reviewed.detail).toContain('Dry run')
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: { key: 'ci/test', name: 'ci/test', state: 'pass', tree },
    })
    const land = await h.call('POST', `${R}/changes/${c.json.number}/land`, {
      body: { expected_tree: tree },
    })
    expect(land.status).toBe(200)
    expect(land.json.state).toBe('landed')
  })

  /**
   * A git store where `main` is the base and any other ref is the change's
   * head, which may carry a different policy file.
   */
  const gitWith = (headPolicy: string) => {
    const tree = (ref: string | undefined): Map<string, string> =>
      new Map(
        ref === undefined || ref === 'main'
          ? [
              ['.source/policy/main.yml', 'rules: []\n'],
              ['src/lib.rs', 'a'],
            ]
          : [
              ['.source/policy/main.yml', headPolicy],
              ['src/lib.rs', 'b'],
            ],
      )
    const fail = () => Promise.reject(new Error('not in this store'))
    return {
      files: (_repo: string, ref?: string) =>
        Promise.resolve({
          ref: ref ?? 'main',
          paths: [...tree(ref).keys()],
          complete: true,
        }),
      blob: (_repo: string, path: string, ref?: string) => {
        const text = tree(ref).get(path)
        return Promise.resolve(
          text === undefined ? null : new TextEncoder().encode(text),
        )
      },
      commits: () => Promise.resolve([]),
      commit: fail,
      diff: fail,
    }
  }

  test('auto-land lands a change once it can, under whoever turned it on', async () => {
    const h = harness({ git: gitWith('rules: []\n') })
    const on = await h.call('PATCH', R, { body: { auto_land: true } })
    expect(on.json.auto_land).toBe(true)
    const c = await h.call('POST', `${R}/changes`, {
      token: sampleTokens.scoped,
      body: { branch: 'auto' },
      headers: AGENT,
    })
    expect(c.json.state).toBe('open')
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: {
        key: 'ci/test',
        name: 'ci/test',
        state: 'pass',
        tree: c.json.head.tree,
      },
    })
    const after = await h.call('GET', `${R}/changes/${c.json.number}`)
    expect(after.json.state).toBe('landed')
    const landed = (
      await h.call('GET', `/events?repo=dana/gitfs&limit=20`)
    ).json.data.find((e: { type: string }) => e.type === 'change.landed')
    expect(landed.actor.handle).toBe('dana')
    expect(landed.via).toEqual({
      machine: null,
      tool: 'auto-land',
      model: null,
    })
  })

  test('a change whose head edits the policy never lands by itself, whatever its file list says', async () => {
    const h = harness({ git: gitWith('rules: []\nexceptions: [everyone]\n') })
    await h.call('PATCH', R, { body: { auto_land: true } })
    const c = await h.call('POST', `${R}/changes`, {
      body: { branch: 'sneaky' },
    })
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: c.json.head.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${c.json.number}`)).json.state,
    ).toBe('open')
  })

  test('it lands only the commit that was checked: a moved head waits', async () => {
    const h = harness({ git: gitWith('rules: []\n') })
    await h.call('PATCH', R, { body: { auto_land: true } })
    const c = await h.call('POST', `${R}/changes`, {
      body: { branch: 'moved' },
    })
    const n = String(c.json.number)
    expect(await h.api.port.autoLand('dana', 'gitfs', n, 'f'.repeat(40))).toBe(
      false,
    )
    expect((await h.call('GET', `${R}/changes/${n}`)).json.state).toBe('open')
  })

  test('a change by a denounced author, or declared with a declined model, never lands by itself', async () => {
    const h = harness({ git: gitWith('rules: []\n') })
    await h.call('PATCH', R, { body: { auto_land: true } })
    const c = await h.call('POST', `${R}/changes`, {
      token: sampleTokens.scoped,
      body: { branch: 'later-declined' },
      headers: AGENT,
    })
    await h.call('PATCH', R, { body: { declined_models: ['Claude Opus 5.5'] } })
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: c.json.head.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${c.json.number}`)).json.state,
    ).toBe('open')
  })

  // The landing steps live in the memory domain's record; Convex reads the
  // same steps from its own policy and is checked by the same rule.
  test.skipIf(onConvex)(
    'a landing that waits on more checks waits for them',
    async () => {
      const h = harness({ git: gitWith('rules: []\n') })
      const repo = (
        h.api.domain as unknown as {
          repos: Map<string, { landing?: unknown }>
        }
      ).repos.get('dana/gitfs')!
      repo.landing = {
        ...DEFAULT_LANDING,
        steps: [{ wait_checks: ['ci/e2e'] }],
      }
      await h.call('PATCH', R, { body: { auto_land: true } })
      const c = await h.call('POST', `${R}/changes`, {
        body: { branch: 'e2e' },
      })
      await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
        body: { key: 'ci/test', state: 'pass', tree: c.json.head.tree },
      })
      expect(
        (await h.call('GET', `${R}/changes/${c.json.number}`)).json.state,
      ).toBe('open')
    },
  )

  test("a patch set to a denounced author's change is refused, from anyone", async () => {
    const h = harness()
    const c = await h.call('POST', `${R}/changes`, {
      token: sampleTokens.scoped,
      body: { branch: 'by-dana' },
    })
    await h.call('PATCH', R, {
      body: { denounced: [{ handle: 'dana', reason: 'testing' }] },
    })
    const ps = await h.call(
      'POST',
      `${R}/changes/${c.json.number}/patch-sets`,
      {
        token: sampleTokens.hollis,
        body: { sha: '7'.repeat(40), kind: 'update' },
      },
    )
    expect(ps.json.code).toBe('denounced')
  })

  test('turning auto-land on takes a login that may land', async () => {
    const h = harness()
    const { secret } = await h.api.port.svc.auth.create({
      name: 'settings only',
      kind: 'personal',
      handle: 'dana',
      scopes: ['repo:read', 'repo:write'] as never,
      ttlMs: 86_400_000,
    })
    const r = await h.call('PATCH', R, {
      token: secret,
      body: { auto_land: true },
    })
    expect(r.status).toBe(403)
    expect(r.json.required_scopes).toEqual(['pulls:merge'])
    // The same token may still change other settings.
    const ok = await h.call('PATCH', R, {
      token: secret,
      body: { description: 'still fine' },
    })
    expect(ok.status).toBe(200)
  })

  test('a head declared a rebase never lands by itself', async () => {
    const h = harness({ git: gitWith('rules: []\n') })
    await h.call('PATCH', R, { body: { auto_land: true } })
    const c = await h.call('POST', `${R}/changes`, { body: { branch: 'rb' } })
    const ps = await h.call(
      'POST',
      `${R}/changes/${c.json.number}/patch-sets`,
      {
        body: { sha: '6'.repeat(40), kind: 'rebase' },
      },
    )
    expect(ps.status).toBe(201)
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: ps.json.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${c.json.number}`)).json.state,
    ).toBe('open')
  })

  test('when git cannot say what a change touches, it waits for a person', async () => {
    const h = harness()
    await h.call('PATCH', R, { body: { auto_land: true } })
    const c = await h.call('POST', `${R}/changes`, {
      body: { branch: 'unknown' },
    })
    await h.call('POST', `${R}/changes/${c.json.number}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: c.json.head.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${c.json.number}`)).json.state,
    ).toBe('open')
  })

  test('auto-land never takes a draft, and never a failing check', async () => {
    const h = harness()
    await h.call('PATCH', R, { body: { auto_land: true } })
    const draft = await h.call('POST', `${R}/changes`, {
      body: { branch: 'draft-auto', draft: true },
    })
    await h.call('POST', `${R}/changes/${draft.json.number}/checks`, {
      body: { key: 'ci/test', state: 'pass', tree: draft.json.head.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${draft.json.number}`)).json.state,
    ).toBe('draft')
    const red = await h.call('POST', `${R}/changes`, {
      body: { branch: 'red' },
    })
    await h.call('POST', `${R}/changes/${red.json.number}/checks`, {
      body: { key: 'ci/test', state: 'fail', tree: red.json.head.tree },
    })
    expect(
      (await h.call('GET', `${R}/changes/${red.json.number}`)).json.state,
    ).toBe('open')
  })

  test('changes to what protects the repository never land by themselves', () => {
    for (const p of [
      '.source/policy/main.yml',
      '.github/workflows/ci.yml',
      '.env.schema',
      'apps/web/.env.schema',
      '.github/CODEOWNERS',
      '.github/actions/setup/action.yml',
      '.circleci/config.yml',
      'Jenkinsfile',
      '.travis.yml',
    ])
      expect(isSensitivePath(p), p).toBe(true)
    for (const p of ['src/refs.rs', 'docs/policy.md', '.envrc'])
      expect(isSensitivePath(p), p).toBe(false)
  })
})
