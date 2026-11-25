import { personPrincipal } from './auth'
import { createHash } from 'node:crypto'
import { formatSource } from './format'
import { randomSource } from './ids'
import { STACK_ID, T0, sampleTokens, seedStack } from './sample'
import { buildOpenApi } from './openapi'
import { errorCatalog } from './problem'
import { allOperations, createSampleApi } from './index'
import { MemoryMailer } from './mail'
import type { Op } from './registry'

type Json = Record<string, any>

const BASE = 'https://api.cobaltforge.dev/v1'

type Recorded = {
  method: string
  path: string
  token: string | null
  headers: Record<string, string>
  body: unknown
  status: number
  responseHeaders: Record<string, string>
  json: unknown
  text: string
  raw?: boolean
}

function seededRandom() {
  let x = 0x2545f491
  return (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      out[i] = x & 0xff
    }
    return out
  }
}

async function authorizeAnApp(api: {
  fetch: (r: Request) => Promise<Response>
  oauth?: unknown
}) {
  const f = (path: string, init: RequestInit = {}) =>
    api.fetch(
      new Request(`https://api.cobaltforge.dev/v1${path}`, {
        redirect: 'manual',
        ...init,
      }),
    )
  const form = (d: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(d).toString(),
  })
  const reg = (await (
    await f('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'My agent',
        redirect_uris: ['http://127.0.0.1:8123/callback'],
      }),
    })
  ).json()) as Json
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const cookie = (
    await f('/oauth/session', {
      ...form({ handle: 'dana', return_to: '/' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://cobaltforge.dev',
      },
    })
  ).headers
    .get('set-cookie')!
    .split(';')[0]
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: 'http://127.0.0.1:8123/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'repo:read pulls:read',
  })
  const html = await (
    await f(`/oauth/authorize?${q}`, { headers: { cookie } })
  ).text()
  const done = await f('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      request_id: /name="request_id" value="([^"]+)"/.exec(html)![1],
      csrf: /name="csrf" value="([^"]+)"/.exec(html)![1],
      decision: 'approve',
    }).toString(),
  })
  const code = new URL(done.headers.get('location')!).searchParams.get('code')!
  await f(
    '/oauth/token',
    form({
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1:8123/callback',
      code_verifier: verifier,
    }),
  )
}

export async function captureExamples(): Promise<Map<string, Recorded>> {
  const original = randomSource.bytes
  randomSource.bytes = seededRandom()
  const now = () => T0 + 3_600_000
  const mail = new MemoryMailer()
  const fresh = () =>
    createSampleApi({
      ephemeralSecrets: true,
      mail,
      mount: '/v1',
      base: BASE,
      now,
      seed: (d) => {
        seedStack(d)
        d.stepDelayMs = 2
      },
      pools: undefined,
      transport: {
        send: () => Promise.resolve({ status: 200, error: null, ms: 38 }),
      },
    })
  let api = fresh()
  const out = new Map<string, Recorded>()
  const t = sampleTokens
  const call = async (
    opId: string | null,
    method: string,
    path: string,
    init: {
      token?: string | null
      body?: unknown
      headers?: Record<string, string>
      bytes?: Uint8Array
      session?: string
    } = {},
  ) => {
    const token = init.session
      ? null
      : init.token === undefined
        ? t.dana
        : init.token
    const headers: Record<string, string> = { ...init.headers }
    if (token) headers.authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const req = new Request(`https://api.cobaltforge.dev/v1${path}`, {
      method,
      headers,
      body: init.bytes
        ? (init.bytes as unknown as BodyInit)
        : init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    })
    const res = init.session
      ? await api.fetchAs(personPrincipal(init.session, Date.now()), req)
      : await api.fetch(req)
    const binary =
      !(res.headers.get('content-type') ?? '').includes('json') &&
      res.status !== 204 &&
      res.status !== 304
    const text = binary
      ? `[${(await res.arrayBuffer()).byteLength} bytes]`
      : await res.text()
    const rec: Recorded = {
      method,
      path,
      token,
      headers: init.headers ?? {},
      body: init.body,
      status: res.status,
      responseHeaders: Object.fromEntries(res.headers),
      json: text && !binary ? (JSON.parse(text) as unknown) : null,
      text,
      raw: init.bytes !== undefined,
    }
    if (opId && !out.has(opId)) out.set(opId, rec)
    return rec
  }
  const R = '/repos/dana/gitfs'

  try {
    await call('status.get', 'GET', '/status', { token: null })
    await call('api.root', 'GET', '/', { token: null })
    await call('api.errors', 'GET', '/errors', { token: null })
    await call('api.limits', 'GET', '/limits', { token: null })
    await call('api.openapi', 'GET', '/openapi.json', { token: null })
    await call('auth.principal', 'GET', '/auth/principal')
    await call('accounts.list', 'GET', '/accounts')
    await call('accounts.get', 'GET', '/accounts/dana')
    await call('repos.list', 'GET', '/repos?limit=2')
    await call('repos.get', 'GET', R)
    await call('repos.context', 'GET', `${R}/context`)
    await call('repos.number', 'GET', `${R}/numbers/216`)
    await call(
      'changes.list',
      'GET',
      `${R}/changes?limit=2&fields=number,title,state,checks,policy`,
    )
    await call('changes.get', 'GET', `${R}/changes/216`)
    await call('patch_sets.list', 'GET', `${R}/changes/216/patch-sets`)
    await call('patch_sets.get', 'GET', `${R}/changes/216/patch-sets/3`)
    await call('patch_sets.files', 'GET', `${R}/changes/216/patch-sets/3/files`)
    await call(
      'patch_sets.compare',
      'GET',
      `${R}/changes/216/compare?from=2&to=3`,
    )
    await call('findings.list', 'GET', `${R}/changes/216/findings?state=open`)
    await call('checks.list', 'GET', `${R}/changes/216/checks`)
    await call('policy.get', 'GET', `${R}/changes/216/policy`)
    await call('policy.simulate', 'POST', `${R}/changes/216/policy/simulate`, {
      body: { checks: { 'ci/test': 'pass' }, resolve: ['F-2'] },
    })
    await call(
      'changes.land',
      'POST',
      '/repos/dana/stacky/changes/1/land?dry_run=true',
      { body: { expected_tree: '1111111' } },
    )
    await call(
      'findings.resolve',
      'POST',
      `${R}/changes/216/findings/F-2/resolve`,
    )
    await call(
      'findings.dismiss',
      'POST',
      `${R}/changes/216/findings/F-3/dismiss`,
      {
        body: { reason: 'Covered by the docs change in #209' },
      },
    )
    await call('checks.report', 'POST', `${R}/changes/216/checks`, {
      body: {
        key: 'ci/test',
        state: 'pass',
        tree: '9c4d7e1',
        details_url: 'https://ci.example.com/runs/881',
      },
    })
    await call('reviews.create', 'POST', `${R}/changes/212/reviews`, {
      token: t.hollis,
      body: {
        state: 'commented',
        body: 'The regression test covers it. One question inline.',
      },
    })
    await call('patch_sets.create', 'POST', `${R}/changes/212/patch-sets`, {
      body: { sha: '8e41c07d2b9a', kind: 'update', note: 'Handle UNC paths' },
    })
    await call('changes.update', 'PATCH', `${R}/changes/212`, {
      body: {
        title: 'Normalize Windows and UNC path separators',
        labels: ['windows', 'bug'],
      },
    })
    await call('changes.create', 'POST', `${R}/changes`, {
      token: t.scoped,
      body: {
        branch: 'fix/trailing-dot-refs',
        title: 'Reject trailing-dot ref names',
        draft: true,
      },
    })
    await call('changes.mark_ready', 'POST', `${R}/changes/218/ready`)
    await call('changes.abandon', 'POST', `${R}/changes/218/abandon`)
    await call('changes.restore', 'POST', `${R}/changes/218/restore`)
    await call('changes.land', 'POST', `${R}/changes/216/land?dry_run=true`, {
      body: { expected_tree: '9c4d7e1' },
    })
    await call('issues.list', 'GET', `${R}/issues?state=all&limit=2`)
    await call('issues.get', 'GET', `${R}/issues/4`)
    await call('issues.create', 'POST', `${R}/issues`, {
      body: { title: 'Crash on empty repo', labels: ['bug'] },
      headers: { 'idempotency-key': 'c1f0e7a2-5b1d-4f3a-9a7c-2d6e8b0f4a11' },
    })
    const etag = (await call(null, 'GET', `${R}/issues/4`)).responseHeaders.etag
    await call('issues.update', 'PATCH', `${R}/issues/4`, {
      body: { state: 'closed' },
      headers: { 'if-match': etag },
    })
    await call('labels.list', 'GET', `${R}/labels`)
    await call('labels.create', 'POST', `${R}/labels`, {
      body: { name: 'windows', color: 'blue', description: 'Windows only' },
    })
    await call('labels.update', 'PATCH', `${R}/labels/windows`, {
      body: { color: 'purple' },
    })
    await call('labels.delete', 'DELETE', `${R}/labels/windows`)
    await call('comments.list', 'GET', `${R}/issues/4/comments`)
    const said = await call(
      'comments.create',
      'POST',
      `${R}/issues/4/comments`,
      {
        body: { body: 'Fixed by #217, closing.' },
        headers: { 'idempotency-key': '5e0b7d1c-2a4f-4c8e-b3d9-71f6a2c0e9b4' },
      },
    )
    const cid = (said.json as Json).id as string
    await call('comments.update', 'PATCH', `${R}/issues/comments/${cid}`, {
      body: { body: 'Fixed by #217.' },
    })
    await call('comments.delete', 'DELETE', `${R}/issues/comments/${cid}`)
    const thread = await call(
      'change_comments.create',
      'POST',
      `${R}/changes/216/comments`,
      {
        body: {
          body: 'Does this still hold when the ref is packed?',
          file: 'src/refs.rs',
          line: 3,
        },
        headers: { 'idempotency-key': '8a1e5c3d-7b2f-4d9a-b6e0-3c4f1a2d5e7b' },
      },
    )
    const tid = (thread.json as Json).id as string
    await call(null, 'POST', `${R}/changes/216/comments`, {
      body: { body: 'Done in patch set 3.', reply_to: tid },
    })
    await call('change_comments.list', 'GET', `${R}/changes/216/comments`)
    const ps3 = (await call(null, 'GET', `${R}/changes/216/patch-sets/3/files`))
      .json as Json
    const refs = (ps3.files as Array<Json>).find(
      (f) => f.path === 'src/refs.rs',
    )!.content as string
    await call(null, 'POST', `${R}/changes/216/patch-sets`, {
      body: {
        kind: 'update',
        files: {
          'src/refs.rs': `// Packed refs go through the same lookup.\n${refs}`,
        },
      },
    })
    await call(
      'change_comments.address',
      'POST',
      `${R}/changes/216/comments/${tid}/address`,
      { body: { note: 'Packed refs go through the same lookup now.' } },
    )
    await call(
      'change_comments.update',
      'PATCH',
      `${R}/changes/216/comments/${tid}`,
      { body: { resolved: true } },
    )
    await call(
      'change_comments.delete',
      'DELETE',
      `${R}/changes/216/comments/${tid}`,
    )
    await call(
      'events.list',
      'GET',
      '/events?repo=dana/gitfs&type=issue.*&limit=2',
    )
    const snap = await call('sync.get', 'GET', '/sync?repo=dana/tinyqueue')
    await call(
      null,
      'GET',
      `/sync?repo=dana/tinyqueue&cursor=${(snap.json as Json).cursor}`,
    )
    await call('api.batch', 'POST', '/batch', {
      body: {
        requests: [
          {
            id: 'change',
            method: 'GET',
            path: '/repos/dana/gitfs/changes/216?fields=number,title,policy',
          },
          {
            id: 'checks',
            method: 'GET',
            path: '/repos/dana/gitfs/changes/216/checks',
          },
          {
            id: 'missing',
            method: 'GET',
            path: '/repos/dana/gitfs/changes/999',
          },
        ],
      },
    })
    await call('tokens.create', 'POST', '/tokens', {
      body: {
        name: 'ci',
        scopes: ['repo:read', 'pulls:read'],
        expires_in_days: 30,
        repos: ['dana/gitfs'],
      },
    })
    await call('tokens.list', 'GET', '/tokens')
    const made = (out.get('tokens.create')!.json as Json).id as string
    await call('tokens.get', 'GET', `/tokens/${made}`)
    await call('tokens.revoke', 'DELETE', `/tokens/${made}`)
    await authorizeAnApp(api)
    await call('authorizations.list', 'GET', '/authorizations')
    const atz = (
      (out.get('authorizations.list')!.json as Json).data as Array<Json>
    )[0].id as string
    await call('authorizations.revoke', 'DELETE', `/authorizations/${atz}`)

    await call('webhooks.create', 'POST', `${R}/webhooks`, {
      body: {
        endpoint: 'https://hooks.example.com/cobalt',
        events: ['change.*', 'issue.created'],
        description: 'Chat bridge',
      },
    })
    const hook = (out.get('webhooks.create')!.json as Json).id as string
    await call('webhooks.list', 'GET', `${R}/webhooks`)
    await call('webhooks.get', 'GET', `${R}/webhooks/${hook}`)
    await call('webhooks.update', 'PATCH', `${R}/webhooks/${hook}`, {
      body: { events: ['change.*', 'issue.*'] },
    })
    await call('webhooks.ping', 'POST', `${R}/webhooks/${hook}/ping`)
    await call(null, 'POST', `${R}/issues`, {
      body: { title: 'A webhook will carry this' },
    })
    await new Promise((r) => setTimeout(r, 20))
    await call(
      'webhooks.deliveries.list',
      'GET',
      `${R}/webhooks/${hook}/deliveries?limit=2`,
    )
    const dlv = (
      (out.get('webhooks.deliveries.list')!.json as Json).data as Array<Json>
    )[0].id as string
    await call(
      'webhooks.deliveries.get',
      'GET',
      `${R}/webhooks/${hook}/deliveries/${dlv}`,
    )
    await call(
      'webhooks.deliveries.redeliver',
      'POST',
      `${R}/webhooks/${hook}/deliveries/${dlv}/redeliver`,
    )
    await call('webhooks.replay', 'POST', `${R}/webhooks/${hook}/replay`, {
      body: { after_sequence: 0, limit: 50 },
    })
    await call(
      'webhooks.rotate_secret',
      'POST',
      `${R}/webhooks/${hook}/rotate-secret`,
    )
    await call('webhooks.delete', 'DELETE', `${R}/webhooks/${hook}`)

    await call('search.query', 'GET', '/search?q=negative+cache&limit=2')

    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Array.from({ length: 40 }, (_, i) => i),
    ])
    await call('uploads.create', 'POST', '/uploads', {
      body: {
        filename: 'after.png',
        content_type: 'image/png',
        size: png.length,
      },
    })
    const up = out.get('uploads.create')!.json as Json
    await call(
      'uploads.put',
      'PUT',
      `/uploads/${up.id}/data?${String(up.upload_url).split('?')[1]}`,
      {
        token: null,
        headers: { 'content-type': 'image/png' },
        bytes: png,
      },
    )
    await call('uploads.get', 'GET', `/uploads/${up.id}`)
    await call('evidence.create', 'POST', `${R}/changes/216/evidence`, {
      body: {
        upload: up.id,
        kind: 'image',
        caption: 'After: the cache stats line',
      },
    })
    await call('evidence.list', 'GET', `${R}/changes/216/evidence`)
    await call('uploads.content', 'GET', `/uploads/${up.id}/content`)
    const shot = await call(null, 'POST', '/uploads', {
      body: {
        filename: 'crash.png',
        content_type: 'image/png',
        size: png.length,
      },
    })
    const sj = shot.json as Json
    await call(
      null,
      'PUT',
      `/uploads/${sj.id}/data?${String(sj.upload_url).split('?')[1]}`,
      { token: null, headers: { 'content-type': 'image/png' }, bytes: png },
    )
    await call('issue_evidence.create', 'POST', `${R}/issues/4/evidence`, {
      body: {
        upload: sj.id,
        kind: 'image',
        caption: 'The error on an empty repo',
      },
    })
    await call('issue_evidence.list', 'GET', `${R}/issues/4/evidence`)
    await call('findings.create', 'POST', `${R}/changes/216/findings`, {
      token: t.hollis,
      body: {
        severity: 'medium',
        file: 'src/refs.rs',
        line: 3,
        title: 'The cache is never bounded',
        body: 'A long-running mount keeps every missing ref forever.',
      },
      headers: { 'idempotency-key': '2f7a9c1e-4b3d-4e8a-9f6b-1c0d5e7a3b28' },
    })

    await call('repos.create', 'POST', '/repos', {
      body: { name: 'notes2', description: 'Scratch', visibility: 'private' },
    })
    await call('changes.guide.put', 'PUT', `${R}/changes/216/guide`, {
      body: {
        summary: 'Caches missing refs so a lookup reads the disk once.',
        order: [
          {
            path: 'src/refs.rs',
            why: 'The cache, and where a miss fills it.',
            risk: 'medium',
          },
          { path: 'tests/refs_test.rs', why: 'Proves one read.', risk: 'low' },
        ],
      },
    })
    await call('changes.guide.get', 'GET', `${R}/changes/216/guide`)
    await call('changes.seen.put', 'PUT', `${R}/changes/216/seen`, {
      body: { paths: ['src/refs.rs'] },
    })
    await call('changes.seen.get', 'GET', `${R}/changes/216/seen`)
    await call('changes.landability', 'GET', `${R}/changes/216/landability`)
    await call('changes.presence.put', 'PUT', `${R}/changes/216/presence`, {
      body: { session: 'tab-7f3a91c2', path: 'src/refs.rs' },
    })
    await call('changes.presence.get', 'GET', `${R}/changes/216/presence`)
    await call('issues.presence.put', 'PUT', `${R}/issues/4/presence`, {
      body: { session: 'tab-7f3a91c2' },
    })
    await call('issues.presence.get', 'GET', `${R}/issues/4/presence`)
    await call('changes.timeline', 'GET', `${R}/changes/216/timeline?limit=5`)
    await call('issues.timeline', 'GET', `${R}/issues/4/timeline`)
    await call('stars.add', 'PUT', `${R}/star`)
    await call('stars.get', 'GET', `${R}/star`)
    await call('stars.remove', 'DELETE', `${R}/star`)
    await call('repos.contributors', 'GET', `${R}/contributors`)
    await call('repos.insights', 'GET', `${R}/insights`)
    await call('dashboard.get', 'GET', '/dashboard')
    await call('preferences.get', 'GET', '/user/preferences')
    await call('preferences.update', 'PATCH', '/user/preferences', {
      body: { show_agents: false },
    })
    await call('follows.add', 'PUT', '/user/following/hollis')
    await call('follows.followers', 'GET', '/accounts/dana/followers')
    await call('follows.following', 'GET', '/accounts/dana/following')
    await call('follows.remove', 'DELETE', '/user/following/hollis')
    await call('accounts.profile', 'GET', '/accounts/dana/profile')
    await call('people.list', 'GET', '/people?limit=2', { token: null })
    await call('policy.rules', 'GET', `${R}/policy`)
    await call('policy.update_rule', 'PATCH', `${R}/policy/rules/reviewed`, {
      body: { mode: 'enforce' },
    })
    await call('policy.create_rule', 'POST', `${R}/policy/rules`, {
      body: {
        id: 'docs-owners',
        name: 'Docs need a docs owner',
        kind: 'path_approval',
        paths: ['docs/**'],
        approvals: 1,
        from: ['hollis'],
      },
    })
    await call('policy.delete_rule', 'DELETE', `${R}/policy/rules/docs-owners`)
    const exception = await call(
      'policy.add_exception',
      'POST',
      `${R}/policy/exceptions`,
      {
        body: {
          rule: 'reviewed',
          who: 'hollis',
          reason: 'On call this week',
          expires_at: '2026-11-14T09:00:00Z',
        },
        headers: { 'idempotency-key': '3c9d1f6e-8b2a-4e7c-a1d5-6f0b9e2c4a77' },
      },
    )
    await call(
      'policy.remove_exception',
      'DELETE',
      `${R}/policy/exceptions/${(exception.json as Json).id as string}`,
    )
    await call('policy.proposals.create', 'POST', `${R}/policy/proposals`, {
      body: {
        edits: [
          { op: 'set_mode', rule: 'reviewed', mode: 'enforce' },
          {
            op: 'set_landing',
            fresh_approvals: true,
            steps: [{ wait_checks: ['ci/test'] }],
          },
        ],
      },
      headers: { 'idempotency-key': '7a1e3c9b-2d4f-4b6a-8e0c-1f5d7b9a3c62' },
    })
    await call('pipelines.list', 'GET', `${R}/pipelines?limit=2`)
    await call('pipelines.get', 'GET', `${R}/pipelines/1839`)
    await call('pipelines.log', 'GET', `${R}/pipelines/1839/jobs/1/steps/2/log`)
    await call('pipelines.rerun', 'POST', `${R}/pipelines/1839/rerun`, {
      headers: { 'idempotency-key': '0b7c2e4f-1a3d-4e6b-9c8a-5d2f7e1b3a90' },
    })
    await call('pipelines.cancel', 'POST', `${R}/pipelines/1840/cancel`)
    await call('pipelines.start', 'POST', `${R}/pipelines`, {
      body: { workflow: 'build', branch: 'main' },
      headers: { 'idempotency-key': '6d2a9f4b-3c1e-4b7a-8e5d-0f9c2b4a6e13' },
    })
    const job = await call('pipelines.claim', 'POST', `${R}/pipelines/claim`, {
      body: { runner: 'mac-mini-1' },
    })
    const claimed = job.json as Json
    await call(
      'pipelines.report',
      'POST',
      `${R}/pipelines/${claimed.run as number}/jobs/${claimed.job as number}/steps/1`,
      {
        body: {
          status: 'success',
          lines: [{ text: 'cargo fmt --check', level: 'cmd' }],
          duration_ms: 2140,
        },
      },
    )
    const step2 = `${R}/pipelines/${claimed.run as number}/jobs/${claimed.job as number}/steps/2`
    await call(null, 'POST', step2, { body: { status: 'running' } })
    await call('pipelines.wait', 'POST', `${step2}/wait`, {
      body: {
        kind: 'person',
        reason: 'Check the migration plan before it runs',
        target: 'hollis',
        expires_at: new Date(now() + 3 * 86_400_000).toISOString(),
      },
    })
    await call('pipelines.resume', 'POST', `${step2}/resume`, {
      body: { status: 'success', summary: 'Plan checked, go ahead.' },
    })
    await call('triggers.list', 'GET', `${R}/triggers`)
    await call('access_rules.put', 'PUT', `${R}/access-rules/deal`, {
      body: { kind: 'branch', patterns: ['deal/*'], readers: ['hollis'] },
    })
    await call('access_rules.list', 'GET', `${R}/access-rules`)
    await call('access_rules.delete', 'DELETE', `${R}/access-rules/deal`)
    await call('inbox.list', 'GET', '/inbox?limit=3')
    const runner = (
      await call('runners.create', 'POST', '/runners', {
        body: {
          name: 'mac-mini',
          labels: ['macos', 'arm64', 'xcode-16'],
          repos: ['dana/gitfs'],
          concurrency: 2,
        },
      })
    ).json as Json
    const rt = runner.secret as string
    await call('runners.list', 'GET', '/runners')
    await call('runners.get', 'GET', `/runners/${runner.id as string}`)
    await call('runners.update', 'PATCH', `/runners/${runner.id as string}`, {
      body: { labels: ['macos', 'arm64', 'xcode-16', 'xcode-15'] },
    })
    await call('runners.heartbeat', 'POST', '/runners/heartbeat', {
      token: rt,
    })
    const rjob = (
      await call('runners.claim', 'POST', '/runners/claim', { token: rt })
    ).json as Json | null
    if (rjob) {
      await call('runners.report', 'POST', '/runners/report', {
        token: rt,
        body: {
          repo: 'dana/gitfs',
          run: rjob.run,
          job: rjob.job,
          step: 1,
          status: 'running',
          lines: [{ text: 'cargo build --release', level: 'cmd' }],
        },
      })
      await call('runners.wait', 'POST', '/runners/wait', {
        token: rt,
        body: {
          repo: 'dana/gitfs',
          run: rjob.run,
          job: rjob.job,
          step: 1,
          kind: 'approval',
          reason: 'Sign off the release build',
          target: 'hollis',
        },
      })
    }
    await call('runners.jobs', 'GET', `/runners/${runner.id as string}/jobs`, {
      token: rt,
    })
    await call('runners.delete', 'DELETE', `/runners/${runner.id as string}`)
    await call('releases.list', 'GET', `${R}/releases?limit=1`)
    await call('releases.get', 'GET', `${R}/releases/v0.9.0`)
    await call('releases.create', 'POST', `${R}/releases`, {
      body: {
        tag: 'v0.9.1',
        channel: 'stable',
        title: 'A smaller cache',
        notes: { fixed: ['The negative cache is bounded.'] },
        signed: true,
        assets: [
          {
            name: 'gitfs-v0.9.1-aarch64-apple-darwin.dmg',
            platform: 'macos',
            arch: 'arm64',
            size: 14889779,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    })
    await call('releases.update', 'PATCH', `${R}/releases/v0.9.1`, {
      body: { withdrawn: 'Built from the wrong commit. Use v0.9.2.' },
    })
    await call(
      'releases.download',
      'POST',
      `${R}/releases/v0.9.0/assets/gitfs-v0.9.0-aarch64-apple-darwin.dmg/download`,
    )
    await call('integrations.list', 'GET', '/accounts/dana/integrations')
    await call(
      'integrations.connect',
      'PUT',
      '/accounts/dana/integrations/boat',
      {
        body: { key: 'boat_live_k2v8q4' },
      },
    )
    await call('integrations.repo', 'GET', `${R}/integrations`)
    await call('integrations.set', 'PUT', `${R}/integrations/boat`, {
      body: { enabled: true },
    })
    await call(
      'integrations.disconnect',
      'DELETE',
      '/accounts/dana/integrations/boat',
    )
    await call('links.list', 'GET', '/accounts/dana/links')
    await call('links.set', 'PUT', '/accounts/dana/links/gitlab', {
      body: { login: 'dana.okafor' },
    })
    await call('links.remove', 'DELETE', '/accounts/dana/links/gitlab')
    await call('github.device.start', 'POST', '/github/device')
    const polled = await call(
      'github.device.poll',
      'POST',
      '/github/device/poll',
      {
        body: {
          device_code: (out.get('github.device.start')!.json as Json)
            .device_code as string,
        },
      },
    )
    const access = (polled.json as Json).access as string
    const redirect_uri = 'https://cobaltforge.dev/github/callback'
    const oauth = await call('github.oauth.start', 'POST', '/github/oauth', {
      body: { redirect_uri, return_to: '/welcome' },
    })
    await call('github.oauth.finish', 'POST', '/github/oauth/finish', {
      body: {
        code: 'c0de',
        state: new URL((oauth.json as Json).url as string).searchParams.get(
          'state',
        )!,
        redirect_uri,
      },
    })
    await call('github.repos.list', 'POST', '/github/repos', {
      body: { access },
    })
    await call('imports.create', 'POST', '/imports', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    await call('imports.list', 'GET', '/imports')
    await call('notifications.list', 'GET', '/notifications?limit=2')
    await call('notifications.count', 'GET', '/notifications/count')
    const [unread] = (
      (await call(null, 'GET', '/notifications?unread=true')).json as Json
    ).data as Array<Json>
    await call(
      'notifications.read',
      'POST',
      `/notifications/${unread.id as string}/read`,
    )
    await call('notifications.read_all', 'POST', '/notifications/read')
    await call('notifications.preferences', 'GET', '/notifications/preferences')
    await call(
      'notifications.update_preferences',
      'PATCH',
      '/notifications/preferences',
      { body: { release: false, digest: true } },
    )

    await call('accounts.create', 'POST', '/accounts', {
      body: {
        handle: 'harbor-tools',
        name: 'Harbor Tools',
        bio: 'Build tooling for small teams',
      },
    })
    await call('accounts.update', 'PATCH', '/accounts/harbor-tools', {
      body: { bio: 'Build tooling for small teams. Est. 2026.' },
    })
    await call('members.set', 'PUT', '/accounts/harbor-tools/members/hollis', {
      body: { role: 'admin' },
    })
    await call('members.list', 'GET', '/accounts/harbor-tools/members')
    await call(
      'invitations.create',
      'POST',
      '/accounts/harbor-tools/invitations',
      {
        body: { email: 'yuki@example.com', role: 'member' },
      },
    )
    await call('invitations.list', 'GET', '/accounts/harbor-tools/invitations')
    const link = /token=(\S+)/.exec(mail.sent.at(-1)!.text)![1]
    await call('invitations.accept', 'POST', '/invitations/accept', {
      token: t.hollis,
      body: { token: link },
    })
    await call(
      'invitations.create',
      'POST',
      '/accounts/harbor-tools/invitations',
      {
        body: { email: 'sol@example.com', role: 'admin' },
      },
    )
    await call(
      'invitations.revoke',
      'DELETE',
      `/accounts/harbor-tools/invitations/${(out.get('invitations.create')!.json as Json).id as string}`,
    )
    await call(
      'members.remove',
      'DELETE',
      '/accounts/harbor-tools/members/hollis',
    )

    await call('teams.create', 'POST', '/accounts/northwind/teams', {
      body: {
        slug: 'support',
        name: 'Support',
        description: 'Reads private repositories to answer questions',
      },
    })
    await call('teams.list', 'GET', '/accounts/northwind/teams')
    await call('teams.get', 'GET', '/accounts/northwind/teams/support')
    await call('teams.update', 'PATCH', '/accounts/northwind/teams/support', {
      body: { description: 'Reads private repositories to answer customers' },
    })
    await call(
      'teams.members.add',
      'PUT',
      '/accounts/northwind/teams/support/members/stranger',
    )
    await call(
      'teams.repos.set',
      'PUT',
      '/accounts/northwind/teams/support/repos/northwind/relay',
      { body: { permission: 'read' } },
    )
    await call(
      'teams.repos.remove',
      'DELETE',
      '/accounts/northwind/teams/support/repos/northwind/relay',
    )
    await call(
      'teams.members.remove',
      'DELETE',
      '/accounts/northwind/teams/support/members/stranger',
    )
    await call('teams.delete', 'DELETE', '/accounts/northwind/teams/support')

    await call('git.tree', 'GET', `${R}/git/tree`)
    await call('git.blob', 'GET', `${R}/git/blob?path=README.md`)
    await call('git.raw', 'GET', `${R}/git/raw?path=README.md`)
    await call('git.commits', 'GET', `${R}/git/commits?limit=1`)
    await call(
      'repos.provenance',
      'GET',
      `${R}/provenance?path=src/refs.rs&line=3&change=216`,
    )
    const sha = ((out.get('git.commits')!.json as Json).data as Array<Json>)[0]
      .sha as string
    await call('git.commit', 'GET', `${R}/git/commits/${sha}`)
    await call('git.diff', 'GET', `${R}/git/commits/${sha}/diff`)
    await call('repos.update', 'PATCH', '/repos/dana/notes2', {
      body: { name: 'scratch2', description: 'Scratch space' },
    })
    await call('repos.transfer', 'POST', '/repos/dana/scratch2/transfer', {
      body: { owner: 'northwind', confirm: 'dana/scratch2' },
    })
    await call(
      'repos.delete',
      'DELETE',
      '/repos/northwind/scratch2?confirm=northwind/scratch2',
    )
    await call('mirrors.list', 'GET', `${R}/mirrors`)
    await call('mirrors.create', 'POST', `${R}/mirrors`, {
      body: { host: 'codeberg', slug: 'dana/gitfs', direction: 'push' },
    })
    const failing = (
      (out.get('mirrors.list')!.json as Json).data as Array<Json>
    )[1].id as string
    await call('mirrors.sync', 'POST', `${R}/mirrors/${failing}/sync`)
    await call(
      'mirrors.update',
      'PATCH',
      `${R}/mirrors/${(out.get('mirrors.create')!.json as Json).id}`,
      { body: { paused: true } },
    )
    await call(
      'mirrors.delete',
      'DELETE',
      `${R}/mirrors/${(out.get('mirrors.create')!.json as Json).id}`,
    )
    await call('env.list', 'GET', `${R}/env?environment=development`)
    await call('env.set', 'PUT', `${R}/env/STRIPE_KEY/development`, {
      body: { value: 'sk_test_51DocsDocsDocsDocs7q' },
    })
    await call('env.values', 'GET', `${R}/env/development/values`, {
      token: t.scoped,
    })
    const asked = await call(null, 'GET', `${R}/env/production/values`, {
      token: t.scoped,
    })
    const pending = (asked.json as { confirmation: { id: string } })
      .confirmation.id
    await call('confirmations.list', 'GET', `${R}/env/confirmations`, {
      token: t.scoped,
    })
    await call(
      'confirmations.confirm',
      'POST',
      `${R}/env/confirmations/${pending}/confirm`,
      { session: 'dana', body: { ttl_minutes: 30 } },
    )
    await call('env.audit', 'GET', `${R}/env/audit`)
    await call(
      'confirmations.revoke',
      'POST',
      `${R}/env/confirmations/${pending}/revoke`,
      { session: 'dana' },
    )

    const started = await call(
      'stacks.land',
      'POST',
      `/repos/dana/stacky/stacks/${STACK_ID}/land`,
      {
        body: {
          expected_trees: { '1': '1111111', '2': '2222222', '3': '3333333' },
        },
      },
    )
    const op = started.json as Json
    await new Promise((r) => setTimeout(r, 60))
    await call('operations.get', 'GET', `/operations/${op.id}`)
    await api.dispose()
    api = fresh()
    await call(null, 'POST', '/imports', {
      body: {
        host: 'github',
        slug: 'dana-okafor/dotfiles',
        github_access: access,
      },
    })
    await call('repos.provider.get', 'GET', '/repos/dana/dotfiles/provider')
    await call('imports.batch', 'POST', '/imports/batch', {
      body: {
        provider: 'github',
        slugs: ['dana-okafor/notes'],
        github_access: access,
      },
    })
    const providers = api.domain.svc.providers!
    await providers.tick()
    const batch = await call(null, 'POST', '/imports/batch', {
      body: {
        provider: 'github',
        slugs: ['dana-okafor/notes'],
        github_access: access,
      },
    })
    await call(
      'imports.jobs.get',
      'GET',
      `/imports/jobs/${(batch.json as Json).id as string}`,
    )
    const gitlabCallback = 'https://cobaltforge.dev/gitlab/callback'
    const gl = await call(
      'providers.oauth.start',
      'POST',
      '/providers/gitlab/oauth',
      {
        body: { redirect_uri: gitlabCallback, return_to: '/new' },
      },
    )
    await call(
      'providers.oauth.finish',
      'POST',
      '/providers/gitlab/oauth/finish',
      {
        body: {
          code: 'c0de',
          state: new URL((gl.json as Json).url as string).searchParams.get(
            'state',
          )!,
          redirect_uri: gitlabCallback,
        },
      },
    )
    await call('providers.list', 'GET', '/providers')
    await call('providers.repos.list', 'POST', '/providers/gitlab/repos', {
      body: { q: 'zine', forks: false },
    })
    await call(null, 'POST', '/imports', {
      body: { host: 'gitlab', slug: 'dana.okafor/zine' },
    })
    await providers.tick()
    const Z = '/repos/dana/zine/provider'
    await call('repos.provider.refresh', 'POST', `${Z}/refresh`)
    await call('repos.provider.adopt', 'POST', `${Z}/adopt?dry_run=true`)
    await call('repos.provider.pulls.list', 'GET', `${Z}/pulls`)
    await call('repos.provider.pulls.get', 'GET', `${Z}/pulls/3`)
    await call('repos.provider.pulls.patch', 'GET', `${Z}/pulls/3/patch`)
    await call('repos.provider.pulls.comments', 'GET', `${Z}/pulls/3/comments`)
    await call('repos.provider.issues.list', 'GET', `${Z}/issues`)
    await call('repos.provider.issues.get', 'GET', `${Z}/issues/5`)
    await call(
      'repos.provider.issues.comments',
      'GET',
      `${Z}/issues/5/comments`,
    )
    await call('repos.provider.releases.list', 'GET', `${Z}/releases`)
    await call('providers.audit', 'GET', '/providers/audit')
    await call(
      'providers.disconnect',
      'DELETE',
      '/providers/gitlab?dry_run=true',
    )
  } finally {
    randomSource.bytes = original
    await api.dispose()
  }
  return out
}

const cell = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function typeOf(schema: Json | undefined): string {
  if (!schema) return 'any'
  if (schema.$ref) return `\`${String(schema.$ref).split('/').pop()}\``
  if (schema.enum)
    return schema.enum.map((e: unknown) => `\`${String(e)}\``).join(' or ')
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ')
  if (schema.type === 'array') return `array of ${typeOf(schema.items)}`
  if (schema.type === 'object')
    return schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
      ? `object of ${typeOf(schema.additionalProperties)}`
      : 'object'
  const bits: Array<string> = []
  if (schema.minimum !== undefined) bits.push(`min ${schema.minimum}`)
  if (schema.maximum !== undefined) bits.push(`max ${schema.maximum}`)
  if (schema.maxLength !== undefined)
    bits.push(`up to ${schema.maxLength} characters`)
  if (schema.minLength !== undefined && schema.minLength > 0)
    bits.push(`at least ${schema.minLength}`)
  if (schema.format) bits.push(schema.format)
  if (schema.pattern) bits.push('pattern')
  const base = Array.isArray(schema.type)
    ? schema.type.join(' or ')
    : (schema.type ?? 'any')
  return bits.length ? `${base} (${bits.join(', ')})` : base
}

function resolve(doc: Json, schema: Json | undefined): Json | undefined {
  let s = schema
  for (let i = 0; s?.$ref && i < 5; i++)
    s = doc.components.schemas[String(s.$ref).split('/').pop()!]
  return s
}

function responseName(doc: Json, item: Json, op: Op): string {
  if (op.status === 204) return 'no body'
  const content = item.responses[String(op.status ?? 200)]?.content ?? {}
  if (op.responseContentType && op.responseContentType !== 'application/json') {
    if (op.responseContentType === 'text/event-stream')
      return 'a `text/event-stream`'
    if (
      op.responseContentType === '*/*' ||
      op.responseContentType === 'application/octet-stream'
    )
      return 'binary data'
    return `a \`${op.responseContentType}\``
  }
  if (content['text/event-stream']) return 'a `text/event-stream`'
  const schema = resolve(doc, content['application/json']?.schema)
  const kind = schema?.properties?.object?.const
  if (kind === 'list') {
    const inner = resolve(doc, schema?.properties.data?.items)
    const itemKind = inner?.properties?.object?.const
    return itemKind ? `a list of \`${itemKind}\`` : 'a list'
  }
  return kind ? `a \`${kind}\`` : 'a JSON document'
}

function table(rows: Array<Array<string>>, header: Array<string>) {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n')
}

function trim(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    const keep = depth === 0 ? 3 : 2
    const head = value.slice(0, keep).map((v) => trim(v, depth + 1))
    return value.length > keep
      ? [...head, `…and ${value.length - keep} more`]
      : head
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Json).map(([k, v]) => [k, trim(v, depth + 1)]),
    )
  if (typeof value === 'string') {
    const redacted = value
      .replace(/\b((?:cbp|cbb|cbr|cbo|cbf)_)[A-Za-z0-9_-]{6,}/g, '$1…')
      .replace(/\b(whsec_)[A-Za-z0-9_+/=-]{6,}/g, '$1…')
      .replace(/([?&]sig=)[^&]+/g, '$1…')
    return redacted.length > 160 ? `${redacted.slice(0, 157)}…` : redacted
  }
  return value
}

function curl(rec: Recorded) {
  const path = rec.path.replace(/([?&]sig=)[^&]+/g, '$1…')
  const escaped = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const lines = [
    `curl ${rec.method === 'GET' ? '' : `-X ${rec.method} `}"${BASE}${path}"`,
  ]
  if (rec.token) lines.push('  -H "Authorization: Bearer $CB_TOKEN"')
  for (const [k, v] of Object.entries(rec.headers))
    lines.push(`  -H "${escaped(k)}: ${escaped(v)}"`)
  if (rec.raw) lines.push('  --data-binary @after.png')
  else if (rec.body !== undefined) {
    lines.push('  -H "Content-Type: application/json"')
    lines.push(`  -d '${JSON.stringify(rec.body)}'`)
  }
  return lines.join(' \\\n')
}

function example(rec: Recorded, opId: string) {
  const shown = [
    'etag',
    'location',
    'cb-outcome',
    'cb-replayed',
    'cb-dry-run',
    'retry-after',
    'ratelimit',
  ]
    .filter((h) => rec.responseHeaders[h])
    .map((h) => `${h}: ${rec.responseHeaders[h]}`)
  let body = ''
  if (opId === 'api.openapi')
    body = JSON.stringify(
      {
        openapi: '3.1.0',
        info: { title: 'cobalt API', version: '2026-11-07' },
        paths: { '…': '…' },
        components: { '…': '…' },
      },
      null,
      2,
    )
  else if (opId === 'events.stream') body = ''
  else body = rec.json === null ? '' : JSON.stringify(trim(rec.json), null, 2)
  return [
    '```bash',
    curl(rec),
    '```',
    '',
    '```http',
    `HTTP/1.1 ${rec.status}`,
    ...shown,
    '```',
    '',
    ...(body ? ['```json', body, '```'] : []),
  ].join('\n')
}

const pages: Array<{
  file: string
  title: string
  description: string
  icon: string
  match: (id: string) => boolean
}> = [
  {
    file: 'meta',
    title: 'Discovery, identity and batch',
    description:
      'The root, the OpenAPI document, every error and limit, who a token is, and several requests in one.',
    icon: 'ServerIcon',
    match: (id) =>
      id.startsWith('api.') ||
      id.startsWith('auth.') ||
      id.startsWith('status.'),
  },
  {
    file: 'accounts',
    title: 'Accounts',
    description:
      'Who you can act as, profiles, organizations, members, invitations and teams, follows and the directory of people, your preferences, inbox and dashboard, connected services and linked accounts.',
    icon: 'UsersIcon',
    match: (id) =>
      /^(accounts|members|invitations|teams|people|follows|preferences|notifications|inbox|integrations|links|dashboard)\./.test(
        id,
      ),
  },
  {
    file: 'repositories',
    title: 'Repositories',
    description:
      'The repositories you can see, creating, changing, transferring and importing one, accounts on git providers and what is linked to them, stars, releases and the one-call context for starting work.',
    icon: 'FolderIcon',
    match: (id) =>
      /^(repos|stars|releases|imports|github|providers|access_rules)\./.test(
        id,
      ),
  },
  {
    file: 'pipelines',
    title: 'Pipelines',
    description:
      'Pipeline runs, their jobs, steps and logs; steps that wait on a person; the runners that take jobs; the triggers that start them.',
    icon: 'PlayIcon',
    match: (id) => /^(pipelines|runners|triggers)\./.test(id),
  },
  {
    file: 'git-data',
    title: 'Git data',
    description:
      'Directories, files, history and diffs, read from the repository itself.',
    icon: 'CodeBracketIcon',
    match: (id) => id.startsWith('git.'),
  },
  {
    file: 'changes',
    title: 'Changes',
    description:
      'Changes, patch sets, reviews, line comments, findings, checks, landing and stacks.',
    icon: 'GitMergeIcon',
    match: (id) =>
      /^(changes|patch_sets|reviews|change_comments|findings|checks|stacks)\./.test(
        id,
      ),
  },
  {
    file: 'policy',
    title: 'Policy',
    description:
      'The rules a change must meet to land, the exceptions to them, and checking a change against them.',
    icon: 'ShieldCheckIcon',
    match: (id) => id.startsWith('policy.'),
  },
  {
    file: 'issues',
    title: 'Issues',
    description:
      'List, open, edit, assign and close issues; their labels and comments.',
    icon: 'ListBulletIcon',
    match: (id) => /^(issues|labels|comments)\./.test(id),
  },
  {
    file: 'events',
    title: 'Events, sync and operations',
    description:
      'The event log, the stream, keeping a local copy in sync, and long-running operations.',
    icon: 'ArrowPathIcon',
    match: (id) =>
      id.startsWith('events.') ||
      id.startsWith('sync.') ||
      id.startsWith('operations.'),
  },
  {
    file: 'tokens',
    title: 'Tokens and authorizations',
    description:
      'Create, list and revoke tokens, and see the applications you have authorized.',
    icon: 'KeyIcon',
    match: (id) => id.startsWith('tokens.') || id.startsWith('authorizations.'),
  },
  {
    file: 'webhooks',
    title: 'Webhooks',
    description:
      'Create an endpoint, watch deliveries, send one again, replay what was missed.',
    icon: 'ArrowPathIcon',
    match: (id) => id.startsWith('webhooks.'),
  },
  {
    file: 'search',
    title: 'Search',
    description: 'One query across repositories, changes and issues.',
    icon: 'ListBulletIcon',
    match: (id) => id.startsWith('search.'),
  },
  {
    file: 'uploads',
    title: 'Uploads and evidence',
    description:
      'Announce a file, send it to a signed address, attach it to a change.',
    icon: 'ArrowDownTrayIcon',
    match: (id) =>
      id.startsWith('uploads.') ||
      id.startsWith('evidence.') ||
      id.startsWith('issue_evidence.'),
  },
  {
    file: 'secrets-and-mirrors',
    title: 'Secrets and mirrors',
    description:
      "Environment variables and their sealed values for the repository's team, confirmations for production values, and copies on other hosts.",
    icon: 'LockClosedIcon',
    match: (id) =>
      id.startsWith('env.') ||
      id.startsWith('confirmations.') ||
      id.startsWith('mirrors.'),
  },
]

function section(op: Op, doc: Json, examples: Map<string, Recorded>) {
  const item = doc.paths[op.path][op.method.toLowerCase()] as Json
  const out: Array<string> = []
  out.push(
    `### \`${op.id}\``,
    '',
    `\`${op.method} ${op.path}\``,
    '',
    `**${op.summary}**`,
    '',
  )
  if (op.description) out.push(op.description, '')

  const meta: Array<Array<string>> = [
    [
      'Safety',
      `\`${op.safety}\`${op.idempotent ? ', safe to repeat' : ', not safe to repeat blindly'}`,
    ],
    [
      'Needs',
      op.auth === 'required'
        ? 'a token'
        : op.auth === 'optional'
          ? 'nothing for public data, a token otherwise'
          : 'nothing',
    ],
    [
      'Scopes',
      op.scopes?.length ? op.scopes.map((s) => `\`${s}\``).join(', ') : 'none',
    ],
    [
      'Rate limit',
      op.pool === 'none'
        ? 'not limited'
        : `\`${op.pool}\` pool, ${op.cost ?? 1} unit${(op.cost ?? 1) === 1 ? '' : 's'}`,
    ],
  ]
  if (op.dryRun) meta.push(['Dry run', '`?dry_run=true`'])
  if (op.waitOn) meta.push(['Wait', '`?wait=20` with `If-None-Match`'])
  if (op.shapeable) meta.push(['Fields', '`?fields=a,b.c`'])
  if (op.mayBeAsync) meta.push(['Async', 'answers `202` and an operation'])
  meta.push([
    'Success',
    `\`${op.status ?? 200}\`, ${responseName(doc, item, op)}`,
  ])
  if (op.accepted)
    meta.push([
      'Or',
      `\`202\`, ${responseName(doc, item, { ...op, status: 202, accepted: undefined })}: ${op.accepted.description}`,
    ])
  out.push(table(meta, ['About', '']), '')

  const params = (item.parameters ?? []) as Array<Json>
  const path = params.filter((p) => p.in === 'path')
  const query = params.filter((p) => p.in === 'query')
  if (path.length)
    out.push(
      '**Path parameters**',
      '',
      table(
        path.map((p) => [
          `\`${p.name}\``,
          typeOf(p.schema),
          p.description ?? '',
        ]),
        ['Name', 'Type', 'Notes'],
      ),
      '',
    )
  if (query.length)
    out.push(
      '**Query parameters**',
      '',
      table(
        query.map((p) => [
          `\`${p.name}\``,
          typeOf(p.schema),
          [
            p.required ? 'Required.' : '',
            p.schema?.default !== undefined
              ? `Default \`${JSON.stringify(p.schema.default)}\`.`
              : '',
            p.description ?? p.schema?.description ?? '',
          ]
            .filter(Boolean)
            .join(' '),
        ]),
        ['Name', 'Type', 'Notes'],
      ),
      '',
    )
  const body = resolve(
    doc,
    item.requestBody?.content?.['application/json']?.schema,
  )
  if (body?.properties) {
    const req = new Set<string>(body.required ?? [])
    out.push(
      '**Request body**',
      '',
      table(
        Object.entries<Json>(body.properties).map(([k, v]) => [
          `\`${k}\``,
          typeOf(v),
          [
            req.has(k) ? 'Required.' : '',
            v.default !== undefined
              ? `Default \`${JSON.stringify(v.default)}\`.`
              : '',
            v.description ?? '',
          ]
            .filter(Boolean)
            .join(' '),
        ]),
        ['Member', 'Type', 'Notes'],
      ),
      '',
    )
  }

  const errors = (item['x-cb-errors'] as Array<string>).filter(
    (c) => !['rate_limited', 'internal'].includes(c),
  )
  out.push(
    '**Errors**',
    '',
    errors.map((c) => `[\`${c}\`](/docs/api/errors#${c})`).join(', '),
    '',
  )

  const rec = examples.get(op.id)
  if (rec) out.push('**Example**', '', example(rec, op.id), '')
  return out.join('\n')
}

const ERRORS_HEAD =
  '---\nicon: ShieldCheckIcon\ntitle: Errors\ndescription: One error shape with a stable code, a hint for what to do next, and whether a retry can help.\n---\n\nEvery error is `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with a few members of ours. The CLI prints the same object on stderr and the MCP server returns it as an `isError` result, so one parser handles all three.\n\n```json\n{\n  "type": "https://cobaltforge.dev/docs/api/errors#policy_blocked",\n  "title": "Policy blocked this",\n  "status": 409,\n  "code": "policy_blocked",\n  "detail": "#216 cannot land: ci/test is running on tree 9c4d7e1; 1 open: F-2 from greptile.",\n  "hint": "Stop and report the failed requirements. Do not work around the policy.",\n  "retryable": false,\n  "exit_code": 5,\n  "request_id": "req_01m6v2nqt5fs5m8zb0",\n  "requirements": [\n    { "id": "ci-evidence", "state": "pending", "needs": { "check": "ci/test", "bound_to": "tree" } },\n    { "id": "findings", "state": "fail", "needs": { "resolve": ["F-2"] } }\n  ]\n}\n```\n\n| Member       | Use it to                                                                                       |\n| ------------ | ----------------------------------------------------------------------------------------------- |\n| `code`       | Branch on it. It is stable and documented below. `detail` and `hint` wording can change, `code` will not.    |\n| `detail`     | Show a person what happened, in this case.                                                      |\n| `hint`       | Know the next thing to try. It is the same string `cb` prints.                                  |\n| `retryable`  | Decide whether to send the same request again. See below.                                       |\n| `exit_code`  | Map to the CLI\'s exit codes: 2 usage, 3 not found, 4 not signed in, 5 blocked by policy or permission, 6 needs a person. |\n| `request_id` | Quote it when you ask us about a failure. It matches the `Cb-Request-Id` header.                |\n| `errors`     | On a `400`: one entry per field with a JSON Pointer such as `/body/title`, a `code` and a `message`. Never the value you sent, since it might be a secret. |\n\nSome codes add members: `required_scopes`, `requirements`, `current`, `retry_after_seconds`. Each is described under its code.\n\n## Retrying\n\n`retryable: true` means the same request, unchanged, may succeed later. It is the only thing a generic retry loop needs to read.\n\n- **`429` and `503`** are retryable. Wait `Retry-After` seconds, then back off if it fails again.\n- **`request_in_progress`** is retryable with the same `Idempotency-Key`.\n- **`request_outcome_unknown`** is not: the first request with that key made its change, then stopped before it answered, and it will not run again. Read the object to see where it stands.\n- **`policy_blocked`** is retryable only when nothing has failed and every unmet requirement is `pending`, meaning something automatic, like CI, will clear it. If any requirement has `fail`, it is a stop. Report it. Do not look for a way round.\n- Everything else is not. Fix the request, or ask a person.\n\nReads and writes sent with an `Idempotency-Key` are safe to repeat. See [Writes](/docs/api/writes).\n\n## Every code\n\n`GET /v1/errors` returns this table as JSON, so a client or an agent can read it once.\n\n'

const ERROR_GROUPS: Array<[string, Array<string>]> = [
  [
    'The request',
    [
      'invalid_request',
      'cursor_mismatch',
      'unsupported_version',
      'method_not_allowed',
      'payload_too_large',
      'unsupported_media_type',
    ],
  ],
  [
    'Who you are',
    [
      'unauthenticated',
      'token_invalid',
      'token_expired',
      'token_revoked',
      'signature_invalid',
      'insufficient_scope',
      'forbidden',
      'session_required',
      'confirmation_required',
      'denounced',
      'model_declined',
    ],
  ],
  ['Where it is', ['not_found', 'moved']],
  [
    'State and policy',
    [
      'invalid_state',
      'stale_head',
      'parent_not_landed',
      'policy_blocked',
      'version_mismatch',
      'limit_reached',
      'upload_incomplete',
    ],
  ],
  ['Plans and read-only', ['plan_required', 'read_only']],
  [
    'Retries',
    [
      'idempotency_key_reused',
      'request_in_progress',
      'request_outcome_unknown',
    ],
  ],
  ['Limits', ['rate_limited', 'concurrency_limited']],
  ['Our side', ['backend_unavailable', 'secrets_unavailable', 'internal']],
]

function mdxSafe(text: string) {
  let out = text.replace(/\b(?:GET|POST|PATCH|PUT|DELETE) \/\S+/g, (m) => {
    const trail = /[.,;]+$/.exec(m)?.[0] ?? ''
    return `\`${m.slice(0, m.length - trail.length)}\`${trail}`
  })
  for (const tok of [
    'Authorization: Bearer <token>',
    'Content-Type: application/json',
    'errors[]',
    'Cb-Version',
    'Retry-After',
    'Idempotency-Key',
    'If-Match',
    'Location',
    'Allow',
    'request_id',
    'upload_url',
    'required_scopes',
    'current',
  ])
    out = out.replace(
      new RegExp(
        `(?<![\\w\`])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w\`])`,
        'g',
      ),
      `\`${tok}\``,
    )
  return out
    .replace('`cbp_ or cbo_`', '`cbp_` or `cbo_`')
    .replace('cbp_ or cbo_', '`cbp_` or `cbo_`')
}

function errorsPage() {
  const seen = new Set<string>()
  const body: Array<string> = []
  for (const [name, codes] of ERROR_GROUPS) {
    body.push(`## ${name}`, '')
    for (const c of codes) {
      seen.add(c)
      const e = (
        errorCatalog as Record<
          string,
          {
            status: number
            title: string
            retryable: boolean
            exit: number
            hint: string
          }
        >
      )[c]
      body.push(
        `### \`${c}\``,
        '',
        `**${e.status}.** ${e.title}. ${e.retryable ? 'Retryable.' : 'Not retryable.'} CLI exit code ${e.exit}.`,
        '',
        mdxSafe(e.hint),
        '',
      )
    }
  }
  const missing = Object.keys(errorCatalog).filter((c) => !seen.has(c))
  if (missing.length)
    throw new Error(
      `error codes with no group on the errors page: ${missing.join(', ')}`,
    )
  return ERRORS_HEAD + body.join('\n')
}

export async function generateReference(): Promise<Map<string, string>> {
  const ops = allOperations(BASE)
  const doc = buildOpenApi(ops, BASE)
  const examples = await captureExamples()
  const files = new Map<string, string>()
  const covered = new Set<string>()
  for (const page of pages) {
    const mine = ops
      .filter((o) => page.match(o.id))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      )
    for (const o of mine) covered.add(o.id)
    const text = [
      '---',
      `icon: ${page.icon}`,
      `title: ${page.title}`,
      `description: ${page.description}`,
      '---',
      '',
      '{/* Generated from the API definitions by scripts/api-docs.ts. Do not edit by hand. */}',
      '',
      '<Callout type="warn" title="Preview">',
      '  Examples are real responses from the sample data the preview serves.',
      '</Callout>',
      '',
      ...mine.map((o) => section(o, doc, examples)),
    ].join('\n')
    files.set(
      `reference/${page.file}.mdx`,
      await formatSource('page.mdx', text),
    )
  }
  files.set('errors.mdx', await formatSource('errors.mdx', errorsPage()))
  const missing = ops.filter((o) => !covered.has(o.id)).map((o) => o.id)
  if (missing.length)
    throw new Error(`operations with no reference page: ${missing.join(', ')}`)
  return files
}

export const exampleless = async () => {
  const examples = await captureExamples()
  return allOperations(BASE)
    .filter((o) => !examples.has(o.id))
    .map((o) => o.id)
}
