import { describe, expect, test } from 'bun:test'
import { MemoryMailer } from './mail'
import { clock, harness } from './testing'

const ORG = '/accounts/northwind'
const MEMBERS = `${ORG}/members`

describe('editing an account', () => {
  test('a person edits their own account and nobody else does', async () => {
    const h = harness()
    const before = await h.call('GET', '/accounts/dana')
    expect(before.json.bio).toBe('')
    const edited = await h.call('PATCH', '/accounts/dana', {
      body: { bio: 'Storage and git.' },
      headers: { 'if-match': before.headers.get('etag')! },
    })
    expect(edited.status).toBe(200)
    expect(edited.json.bio).toBe('Storage and git.')
    expect(edited.json.version).toBe(before.json.version + 1)
    const after = await h.call('GET', '/accounts/dana', {
      headers: { 'if-none-match': before.headers.get('etag')! },
    })
    expect(after.status).toBe(200)
    expect(after.json.bio).toBe('Storage and git.')

    const other = await h.call('PATCH', '/accounts/dana', {
      token: h.tokens.hollis,
      body: { name: 'Not Dana' },
    })
    expect(other.status).toBe(403)
    expect((await h.call('GET', '/accounts/dana')).json.name).toBe(
      'Dana Okafor',
    )
  })

  test('a stale If-Match is refused and the same values change nothing', async () => {
    const h = harness()
    const read = await h.call('GET', '/accounts/dana')
    await h.call('PATCH', '/accounts/dana', { body: { bio: 'one' } })
    const stale = await h.call('PATCH', '/accounts/dana', {
      body: { bio: 'two' },
      headers: { 'if-match': read.headers.get('etag')! },
    })
    expect(stale.status).toBe(412)
    expect(stale.json.code).toBe('version_mismatch')
    const now = await h.call('GET', '/accounts/dana')
    const same = await h.call('PATCH', '/accounts/dana', {
      body: { bio: 'one' },
    })
    expect(same.json.version).toBe(now.json.version)
  })

  test('an organization is edited by its owners and admins; a member is refused and an outsider sees nothing', async () => {
    const h = harness()
    expect(
      (await h.call('PATCH', ORG, { body: { bio: 'Tools for teams.' } })).json
        .bio,
    ).toBe('Tools for teams.')
    const member = await h.call('PATCH', ORG, {
      token: h.tokens.hollis,
      body: { name: 'Mine now' },
    })
    expect(member.status).toBe(403)
    const outsider = await h.call('PATCH', ORG, {
      token: h.tokens.stranger,
      body: { name: 'Mine now' },
    })
    expect(outsider.status).toBe(404)
    expect(
      (await h.call('PATCH', ORG, { token: h.tokens.limited, body: {} }))
        .status,
    ).toBe(403)
    expect(
      (await h.call('PATCH', '/accounts/nobody', { body: { bio: 'x' } }))
        .status,
    ).toBe(404)
  })

  test('a dry run shows the result and writes nothing', async () => {
    const h = harness()
    const dry = await h.call('PATCH', '/accounts/dana?dry_run=true', {
      body: { bio: 'Maybe.' },
    })
    expect(dry.json.bio).toBe('Maybe.')
    expect((await h.call('GET', '/accounts/dana')).json.bio).toBe('')
  })
})

describe('creating an organization', () => {
  test('the creator is its owner, and asking again returns it unchanged', async () => {
    const h = harness()
    const made = await h.call('POST', '/accounts', {
      body: { handle: 'harbor-tools', name: 'Harbor Tools' },
    })
    expect(made.status).toBe(201)
    expect(made.headers.get('cb-outcome')).toBe('created')
    expect(made.json).toMatchObject({
      kind: 'organization',
      handle: 'harbor-tools',
      name: 'Harbor Tools',
      role: 'owner',
    })
    const again = await h.call('POST', '/accounts', {
      body: { handle: 'harbor-tools' },
    })
    expect(again.status).toBe(200)
    expect(again.headers.get('cb-outcome')).toBe('unchanged')
    expect(again.json.id).toBe(made.json.id)
    const mine = await h.call('GET', '/accounts')
    expect(mine.json.data.map((a: { handle: string }) => a.handle)).toContain(
      'harbor-tools',
    )
    const repo = await h.call('POST', '/repos', {
      body: { owner: 'harbor-tools', name: 'cli', visibility: 'public' },
    })
    expect(repo.status).toBe(201)
    const closed = await h.call('POST', '/repos', {
      body: { owner: 'harbor-tools', name: 'secret', visibility: 'private' },
    })
    expect(closed.status).toBe(402)
    expect(closed.json.code).toBe('plan_required')
  })

  test('a handle is one namespace: a person, another organization or a page of the site has it', async () => {
    const h = harness()
    for (const handle of ['hollis', 'lumen-studio', 'settings', 'docs']) {
      const r = await h.call('POST', '/accounts', { body: { handle } })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('invalid_state')
    }
    await h.call('POST', '/accounts', { body: { handle: 'harbor-tools' } })
    const theirs = await h.call('POST', '/accounts', {
      token: h.tokens.stranger,
      body: { handle: 'harbor-tools' },
    })
    expect(theirs.status).toBe(409)
    for (const handle of ['Harbor', '-x', 'x-', 'a'.repeat(25), 'a b'])
      expect(
        (await h.call('POST', '/accounts', { body: { handle } })).status,
      ).toBe(400)
  })

  test('only a person creates one, with a token that is not limited to repositories', async () => {
    const h = harness()
    const agent = await h.call('POST', '/accounts', {
      token: h.tokens.scoped,
      body: { handle: 'agents-inc' },
    })
    expect([403]).toContain(agent.status)
    const limited = await h.call('POST', '/accounts', {
      token: h.tokens.limited,
      body: { handle: 'limited-inc' },
    })
    expect(limited.status).toBe(403)
    expect((await h.call('GET', '/accounts/agents-inc')).status).toBe(404)
    expect((await h.call('GET', '/accounts/limited-inc')).status).toBe(404)
  })

  test('a dry run creates nothing', async () => {
    const h = harness()
    const dry = await h.call('POST', '/accounts?dry_run=true', {
      body: { handle: 'harbor-tools' },
    })
    expect(dry.json.handle).toBe('harbor-tools')
    expect((await h.call('GET', '/accounts/harbor-tools')).status).toBe(404)
  })
})

describe('members of an organization', () => {
  const roleOf = async (
    h: ReturnType<typeof harness>,
    login: string,
  ): Promise<string | undefined> =>
    (await h.call('GET', MEMBERS)).json.data.find(
      (m: { handle: string }) => m.handle === login,
    )?.role

  test('who is in an organization is public; a person has no members', async () => {
    const h = harness()
    const list = await h.call('GET', MEMBERS, { token: h.tokens.hollis })
    expect(list.status).toBe(200)
    expect(
      list.json.data.map((m: { handle: string; role: string }) => [
        m.handle,
        m.role,
      ]),
    ).toEqual([
      ['dana', 'owner'],
      ['hollis', 'member'],
    ])
    for (const token of [h.tokens.stranger, null])
      expect((await h.call('GET', MEMBERS, { token })).json.data.length).toBe(2)
    expect((await h.call('GET', '/accounts/dana/members')).status).toBe(404)
    expect(
      (await h.call('GET', MEMBERS, { token: h.tokens.limited })).status,
    ).toBe(200)
  })

  test('adding, changing and repeating a role', async () => {
    const h = harness()
    const added = await h.call('PUT', `${MEMBERS}/stranger`, {
      body: { role: 'member' },
    })
    expect(added.status).toBe(201)
    expect(added.headers.get('cb-outcome')).toBe('created')
    const raised = await h.call('PUT', `${MEMBERS}/stranger`, {
      body: { role: 'admin' },
    })
    expect(raised.status).toBe(200)
    expect(raised.headers.get('cb-outcome')).toBe('updated')
    const same = await h.call('PUT', `${MEMBERS}/stranger`, {
      body: { role: 'admin' },
    })
    expect(same.headers.get('cb-outcome')).toBe('unchanged')
    expect(
      (await h.call('GET', MEMBERS, { token: h.tokens.stranger })).status,
    ).toBe(200)
    expect(
      (await h.call('PUT', `${MEMBERS}/nobody`, { body: { role: 'member' } }))
        .status,
    ).toBe(404)
    expect(
      (
        await h.call('PUT', `${MEMBERS}/lumen-studio`, {
          body: { role: 'member' },
        })
      ).status,
    ).toBe(404)
  })

  test('a member cannot manage members, and only an owner makes or changes an owner', async () => {
    const h = harness()
    const S = { token: h.tokens.stranger }
    await h.call('PUT', `${MEMBERS}/stranger`, { body: { role: 'member' } })
    const byMember = await h.call('PUT', `${MEMBERS}/hollis`, {
      ...S,
      body: { role: 'admin' },
    })
    expect(byMember.status).toBe(403)
    expect(byMember.json.code).toBe('forbidden')
    await h.call('PUT', `${MEMBERS}/stranger`, { body: { role: 'admin' } })
    const byAdmin = await h.call('PUT', `${MEMBERS}/hollis`, {
      ...S,
      body: { role: 'admin' },
    })
    expect(byAdmin.status).toBe(200)
    expect(byAdmin.headers.get('cb-outcome')).toBe('updated')
    for (const [login, role] of [
      ['hollis', 'owner'],
      ['stranger', 'owner'],
      ['dana', 'member'],
    ]) {
      const r = await h.call('PUT', `${MEMBERS}/${login}`, {
        ...S,
        body: { role },
      })
      expect(r.status).toBe(403)
      expect(r.json.code).toBe('forbidden')
    }
    expect((await h.call('DELETE', `${MEMBERS}/dana`, S)).status).toBe(403)
    expect(await roleOf(h, 'dana')).toBe('owner')
    expect(await roleOf(h, 'stranger')).toBe('admin')
  })

  test('an organization always keeps an owner', async () => {
    const h = harness()
    const demote = await h.call('PUT', `${MEMBERS}/dana`, {
      body: { role: 'admin' },
    })
    expect(demote.status).toBe(409)
    expect(demote.json.code).toBe('invalid_state')
    expect((await h.call('DELETE', `${MEMBERS}/dana`)).status).toBe(409)
    await h.call('PUT', `${MEMBERS}/stranger`, { body: { role: 'owner' } })
    expect(
      (await h.call('PUT', `${MEMBERS}/dana`, { body: { role: 'member' } }))
        .status,
    ).toBe(200)
    expect((await h.call('DELETE', `${MEMBERS}/dana`)).status).toBe(204)
    expect(await roleOf(h, 'dana')).toBeUndefined()
    const last = await h.call('DELETE', `${MEMBERS}/stranger`, {
      token: h.tokens.stranger,
    })
    expect(last.status).toBe(409)
    expect(last.json.code).toBe('invalid_state')
  })

  test('removing someone ends their access and their team memberships; removing twice is fine', async () => {
    const h = harness()
    await h.call('POST', `${ORG}/teams`, { body: { slug: 'support' } })
    await h.call('PUT', `${ORG}/teams/support/members/hollis`)
    expect((await h.call('GET', `${ORG}/teams/support`)).json.members).toEqual([
      'hollis',
    ])
    expect((await h.call('DELETE', `${MEMBERS}/hollis`)).status).toBe(204)
    expect((await h.call('DELETE', `${MEMBERS}/hollis`)).status).toBe(204)
    expect(await roleOf(h, 'hollis')).toBeUndefined()
    expect((await h.call('GET', `${ORG}/teams/support`)).json.members).toEqual(
      [],
    )
    expect(
      (await h.call('GET', `${ORG}/invitations`, { token: h.tokens.hollis }))
        .status,
    ).toBe(404)
  })

  test('a member can leave; a dry run changes nothing', async () => {
    const h = harness()
    const S = { token: h.tokens.stranger }
    await h.call('PUT', `${MEMBERS}/stranger?dry_run=true`, {
      body: { role: 'admin' },
    })
    expect(await roleOf(h, 'stranger')).toBeUndefined()
    await h.call('PUT', `${MEMBERS}/stranger`, { body: { role: 'member' } })
    const dry = await h.call('DELETE', `${MEMBERS}/stranger?dry_run=true`, S)
    expect(dry.status).toBe(204)
    expect(await roleOf(h, 'stranger')).toBe('member')
    expect((await h.call('DELETE', `${MEMBERS}/hollis`, S)).status).toBe(403)
    expect((await h.call('DELETE', `${MEMBERS}/stranger`, S)).status).toBe(204)
    expect(await roleOf(h, 'stranger')).toBeUndefined()
  })
})

describe('a person who signs in', () => {
  test('is known to the API once, and keeps their account when seen again', async () => {
    const h = harness()
    await h.api.port.knowPerson('quiet-otter-482', 'Test Person')
    const first = await h.call('GET', '/accounts/quiet-otter-482')
    expect(first.json).toMatchObject({ kind: 'person', name: 'Test Person' })
    await h.api.port.knowPerson('quiet-otter-482', 'Test Person')
    const again = await h.call('GET', '/accounts/quiet-otter-482')
    expect(again.json.id).toBe(first.json.id)
    expect(again.json.version).toBe(first.json.version)
    await h.api.port.knowPerson('quiet-otter-482', 'Tess Person')
    expect((await h.call('GET', '/accounts/quiet-otter-482')).json.name).toBe(
      'Tess Person',
    )
    await h.api.port.knowPerson('northwind', 'Someone')
    expect((await h.call('GET', ORG)).json).toMatchObject({
      kind: 'organization',
      name: 'Northwind Labs',
    })
  })
})

describe('invitations by email', () => {
  const INV = '/accounts/northwind/invitations'
  const setup = () => {
    const mail = new MemoryMailer()
    const now = clock()
    const h = harness({ mail, now })
    const tokenIn = (n = -1) => /token=(\S+)/.exec(mail.sent.at(n)!.text)![1]
    return { h, mail, tokenIn, now }
  }

  test('an owner invites, the email carries a link, and accepting it joins', async () => {
    const { h, mail, tokenIn } = setup()
    const made = await h.call('POST', INV, {
      body: { email: 'Sam@Example.com', role: 'admin' },
    })
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      object: 'invitation',
      account: 'northwind',
      email: 'sam@example.com',
      role: 'admin',
      invited_by: 'dana',
    })
    expect(mail.sent.length).toBe(1)
    expect(mail.sent[0].to).toBe('sam@example.com')
    expect(mail.sent[0].text).toContain('/organizations/join?token=cbi_')
    expect(JSON.stringify(made.json)).not.toContain(tokenIn())
    expect((await h.call('GET', INV)).json.data.length).toBe(1)

    const before = await h.call('GET', '/accounts/northwind/invitations', {
      token: h.tokens.stranger,
    })
    expect(before.status).toBe(404)
    const joined = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn() },
    })
    expect(joined.status).toBe(200)
    expect(joined.json).toMatchObject({ handle: 'stranger', role: 'admin' })
    expect((await h.call('GET', INV)).json.data).toEqual([])
    const again = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn() },
    })
    expect(again.status).toBe(404)
  })

  test('inviting the same email again replaces the link', async () => {
    const { h, tokenIn } = setup()
    const first = await h.call('POST', INV, {
      body: { email: 'sam@example.com', role: 'member' },
    })
    const second = await h.call('POST', INV, {
      body: { email: 'sam@example.com', role: 'admin' },
    })
    expect(second.status).toBe(200)
    expect(second.headers.get('cb-outcome')).toBe('updated')
    expect(second.json.id).toBe(first.json.id)
    expect((await h.call('GET', INV)).json.data.length).toBe(1)
    const old = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn(-2) },
    })
    expect(old.status).toBe(404)
    const now = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn() },
    })
    expect(now.json.role).toBe('admin')
  })

  test('a revoked or expired invitation cannot be accepted', async () => {
    const { h, tokenIn, now } = setup()
    const made = await h.call('POST', INV, {
      body: { email: 'sam@example.com', role: 'member' },
    })
    expect((await h.call('DELETE', `${INV}/${made.json.id}`)).status).toBe(204)
    expect((await h.call('DELETE', `${INV}/${made.json.id}`)).status).toBe(204)
    const revoked = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn() },
    })
    expect(revoked.status).toBe(404)

    await h.call('POST', INV, {
      body: { email: 'late@example.com', role: 'member' },
    })
    now.advance(8 * 86_400_000)
    const late = await h.call('POST', '/invitations/accept', {
      token: h.tokens.stranger,
      body: { token: tokenIn() },
    })
    expect(late.status).toBe(404)
    expect((await h.call('GET', INV)).json.data).toEqual([])
  })

  test('only owners and admins invite, and only an owner invites an owner', async () => {
    const { h, mail } = setup()
    await h.call('PUT', '/accounts/northwind/members/stranger', {
      body: { role: 'admin' },
    })
    const asAdmin = await h.call('POST', INV, {
      token: h.tokens.stranger,
      body: { email: 'a@example.com', role: 'owner' },
    })
    expect(asAdmin.status).toBe(403)
    const ok = await h.call('POST', INV, {
      token: h.tokens.stranger,
      body: { email: 'a@example.com', role: 'member' },
    })
    expect(ok.status).toBe(201)
    await h.call('PUT', '/accounts/northwind/members/stranger', {
      body: { role: 'member' },
    })
    const asMember = await h.call('POST', INV, {
      token: h.tokens.stranger,
      body: { email: 'b@example.com', role: 'member' },
    })
    expect(asMember.status).toBe(403)
    expect(
      (await h.call('GET', INV, { token: h.tokens.stranger })).status,
    ).toBe(403)
    expect(mail.sent.length).toBe(1)
  })

  test('accepting never demotes, an agent cannot join, and a bad email is refused', async () => {
    const { h, tokenIn } = setup()
    await h.call('POST', INV, {
      body: { email: 'dana@example.com', role: 'member' },
    })
    const self = await h.call('POST', '/invitations/accept', {
      body: { token: tokenIn() },
    })
    expect(self.json.role).toBe('owner')
    await h.call('POST', INV, {
      body: { email: 'bot@example.com', role: 'member' },
    })
    const agent = await h.call('POST', '/invitations/accept', {
      token: h.tokens.scoped,
      body: { token: tokenIn() },
    })
    expect(agent.status).toBe(403)
    const bad = await h.call('POST', INV, {
      body: { email: 'not-an-email', role: 'member' },
    })
    expect(bad.status).toBe(400)
  })

  test('a dry run sends nothing', async () => {
    const { h, mail } = setup()
    const dry = await h.call('POST', `${INV}?dry_run=true`, {
      body: { email: 'sam@example.com', role: 'member' },
    })
    expect(dry.status).toBe(200)
    expect(mail.sent.length).toBe(0)
    expect((await h.call('GET', INV)).json.data).toEqual([])
  })
})
