import { expect, test } from 'bun:test'
import { harness, onConvex } from '../testing'

test.skipIf(!onConvex)(
  'imported pull requests, issues and releases appear in Changes, Issues and Releases',
  async () => {
    const h = harness()
    const redirect_uri = 'https://cobaltforge.dev/gitlab/callback'
    const gl = await h.call('POST', '/providers/gitlab/oauth', {
      body: { redirect_uri },
    })
    await h.call('POST', '/providers/gitlab/oauth/finish', {
      body: {
        code: 'c',
        state: new URL(gl.json.url).searchParams.get('state'),
        redirect_uri,
      },
    })
    await h.call('POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    const sync = (
      h.api.port as unknown as {
        svc: { providers: { tick: () => Promise<unknown> } }
      }
    ).svc.providers
    await sync.tick()
    const changes = (await h.call('GET', '/repos/dana/zine/changes?state=all'))
      .json.data
    expect(
      changes
        .map((c: { number: number; state: string }) => [c.number, c.state])
        .sort(),
    ).toEqual([
      [2, 'landed'],
      [3, 'open'],
    ])
    const c3 = (await h.call('GET', '/repos/dana/zine/changes/3')).json
    expect(c3.author.handle).toBe('tomas.r@gitlab')
    expect(c3.title).toBe('Add a dark print stylesheet')
    const issue = (await h.call('GET', '/repos/dana/zine/issues/5')).json
    expect(issue).toMatchObject({
      number: 5,
      title: 'Images are blurry in print',
      state: 'open',
    })
    const comments = (await h.call('GET', '/repos/dana/zine/issues/5/comments'))
      .json.data
    expect(comments[0].body).toBe('Same here with the A5 layout.')
    const rel = (await h.call('GET', '/repos/dana/zine/releases')).json.data
    expect(rel[0]).toMatchObject({ tag: 'v0.3.0', title: 'Zine 0.3' })
    const made = await h.call('POST', '/repos/dana/zine/issues', {
      body: { title: 'Ours' },
    })
    expect(made.json.number).toBe(6)
    await sync.tick()
    expect(
      (await h.call('GET', '/repos/dana/zine/changes?state=all')).json.data,
    ).toHaveLength(2)
  },
)
