import { describe, expect, test } from 'bun:test'
import { sampleTokens } from './sample'
import { asPerson, harness, withRunsOn } from './testing'

const R = '/repos/dana/gitfs'

type Item = {
  kind: string
  severity: string
  repo: string | null
  title: string
  note: string
  action: string
  path: string
  subject: { type: string; number: number } | null
}

async function inboxOf(h: ReturnType<typeof harness>, who: string) {
  const r = await asPerson(h, who, 'GET', '/inbox?limit=100')
  expect(r.status).toBe(200)
  return r.json as {
    items: Array<Item>
    counts: Record<string, number>
  }
}

const about = (items: Array<Item>, kind: string, n?: number) =>
  items.filter(
    (x) => x.kind === kind && (n === undefined || x.subject?.number === n),
  )

describe('the inbox', () => {
  test('needs a sign-in, and answers a short queue, most costly first', async () => {
    const h = harness()
    expect((await h.call('GET', '/inbox', { token: null })).status).toBe(401)
    const r = await h.call('GET', '/inbox')
    expect(r.status).toBe(200)
    expect(r.json.object).toBe('inbox')
    const order = [
      'stopped',
      'failing',
      'blocked',
      'review',
      'handoff',
      'assigned',
      'mention',
    ]
    const ranks = r.json.items.map((x: Item) => order.indexOf(x.severity))
    expect(ranks).toEqual([...ranks].sort((a: number, b: number) => a - b))
    expect(r.json.counts.total).toBe(r.json.items.length)
    expect((await h.call('GET', '/inbox?limit=101')).status).toBe(400)
    expect((await h.call('GET', '/inbox?limit=1')).json.items).toHaveLength(1)
  })

  test('each kind appears for the right person', async () => {
    const h = harness()
    const dana = (await inboxOf(h, 'dana')).items
    expect(about(dana, 'mirror_stopped')[0]).toMatchObject({
      severity: 'stopped',
      action: 'fix',
      repo: 'dana/gitfs',
    })
    expect(about(dana, 'change_blocked', 216)[0]).toMatchObject({
      severity: 'blocked',
      action: 'fix',
      path: '/dana/gitfs/changes?n=216',
    })
    expect(about(dana, 'review_requested', 212)[0].action).toBe('review')
    expect(about(dana, 'issue_assigned', 4)[0].action).toBe('open')
    const ines = (await inboxOf(h, 'ines')).items
    expect(about(ines, 'checks_failing', 212)).toHaveLength(1)
    expect(about(ines, 'change_blocked', 212)).toHaveLength(1)
    expect(about(ines, 'change_blocked', 216)).toHaveLength(0)
    const hollis = (await inboxOf(h, 'hollis')).items
    expect(about(hollis, 'mirror_stopped')).toHaveLength(0)
    expect(about(hollis, 'change_blocked')).toHaveLength(0)
  })

  test('an unread mention is there until it is read', async () => {
    const h = harness()
    await h.call('POST', `${R}/issues/4/comments`, {
      body: { body: '@hollis can you look at this one?' },
    })
    const items = (await inboxOf(h, 'hollis')).items
    const m = about(items, 'mention')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({
      severity: 'mention',
      action: 'answer',
      subject: { type: 'issue', number: 4 },
    })
    await asPerson(h, 'hollis', 'POST', '/notifications/read')
    expect(about((await inboxOf(h, 'hollis')).items, 'mention')).toHaveLength(0)
  })

  test('a private repository stays hidden', async () => {
    const h = harness()
    const issue = (
      await h.call('POST', '/repos/dana/notes/issues', {
        body: { title: 'Secret plans' },
      })
    ).json
    await h.call('POST', `/repos/dana/notes/issues/${issue.number}/comments`, {
      body: { body: '@hollis' },
    })
    const items = (await inboxOf(h, 'hollis')).items
    expect(items.some((x) => x.repo === 'dana/notes')).toBe(false)
    expect(JSON.stringify(items)).not.toContain('Secret plans')
  })

  test('your own change is never a review item', async () => {
    const h = harness()
    const dana = (await inboxOf(h, 'dana')).items
    expect(about(dana, 'review_requested', 216)).toHaveLength(0)
    expect(about(dana, 'review_requested', 218)).toHaveLength(0)
  })

  test('a change you already reviewed drops out', async () => {
    const h = harness()
    expect(
      about((await inboxOf(h, 'hollis')).items, 'review_requested', 215),
    ).toHaveLength(1)
    const reviewed = await h.call('POST', `${R}/changes/215/reviews`, {
      token: sampleTokens.hollis,
      body: { state: 'approved', body: 'Looks right.' },
    })
    expect(reviewed.status).toBe(201)
    expect(
      about((await inboxOf(h, 'hollis')).items, 'review_requested', 215),
    ).toHaveLength(0)
  })

  test('a blocked change appears only while it is blocked', async () => {
    const h = harness()
    expect(
      about((await inboxOf(h, 'dana')).items, 'change_blocked', 216),
    ).toHaveLength(1)
    const findings = (await h.call('GET', `${R}/changes/216/findings`)).json
    for (const f of findings.data)
      if (f.state === 'open')
        await h.call('POST', `${R}/changes/216/findings/${f.id}/resolve`, {
          body: { reason: 'Fixed in the next patch set.' },
        })
    const c = (await h.call('GET', `${R}/changes/216`)).json
    expect(c.policy.state).not.toBe('blocked')
    expect(
      about((await inboxOf(h, 'dana')).items, 'change_blocked', 216),
    ).toHaveLength(0)
  })

  test('a queued run with no matching runner appears, with the labels it waits for', async () => {
    const h = await withRunsOn(['macos', 'xcode-16'])
    const run = (
      await h.call('POST', `${R}/pipelines`, { body: { workflow: 'build' } })
    ).json
    const item = about(
      (await inboxOf(h, 'dana')).items,
      'runner_missing',
      run.number,
    )
    expect(item).toHaveLength(1)
    expect(item[0].note).toBe('Waiting for a runner with: macos, xcode-16.')
    expect(item[0].severity).toBe('blocked')
    expect(
      about((await inboxOf(h, 'hollis')).items, 'runner_missing'),
    ).toHaveLength(0)
    await h.call('POST', '/runners', {
      body: { name: 'mac', labels: ['macos', 'xcode-16', 'arm64'] },
    })
    expect(
      about((await inboxOf(h, 'dana')).items, 'runner_missing', run.number),
    ).toHaveLength(0)
  })

  test('the activity feed is still the feed', async () => {
    const h = harness()
    const feed = await h.call('GET', '/notifications')
    expect(feed.status).toBe(200)
    expect(feed.json.object).toBe('list')
  })
})
