// Forgejo 5. User- and organization-level webhooks: do they fire for every
// repository (also ones made after the hook)? Signature (HMAC) and delivery id.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { until } from '../lib'
import { USER, commit, createRepo, forgejo } from './env'
import type { Scenario } from '../lib'

type Delivery = { headers: Partial<Record<string, string>>; body: string }

export const forgejoWebhooks: Scenario = {
  id: 'forgejo-05-webhooks',
  title: 'User and organization webhooks: coverage, HMAC, delivery id',
  async run(ctx) {
    const f = await forgejo()
    const secret = `probe-${randomBytes(16).toString('hex')}`
    const got: Array<Delivery> = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        got.push({
          headers: Object.fromEntries(req.headers),
          body: await req.text(),
        })
        return new Response('ok')
      },
    })
    ctx.onCleanup('webhook receiver', () => void server.stop(true))
    const hookUrl = `http://127.0.0.1:${server.port}/hook`
    const config = { url: hookUrl, content_type: 'json', secret }

    const org = `${ctx.name('org')}`.slice(0, 39)
    const o = await f.api('POST', '/orgs', { username: org })
    ctx.log.line(`org ${org}: HTTP ${o.status}`)
    ctx.onCleanup(`Forgejo org ${org}`, async () => {
      await f.api('DELETE', `/orgs/${org}`)
    })

    const before = ctx.name('fj-hook-before')
    await createRepo(f, before)
    const userHook = await f.api('POST', '/user/hooks', {
      type: 'forgejo',
      config,
      events: ['push'],
      active: true,
    })
    const orgHook = await f.api('POST', `/orgs/${org}/hooks`, {
      type: 'forgejo',
      config,
      events: ['push'],
      active: true,
    })
    ctx.log.line(
      `user hook: HTTP ${userHook.status}; org hook: HTTP ${orgHook.status}`,
    )
    const after = ctx.name('fj-hook-after')
    await createRepo(f, after)
    const orgA = ctx.name('fj-org-a')
    const orgB = ctx.name('fj-org-b')
    await createRepo(f, orgA, org)
    await createRepo(f, orgB, org)
    for (const r of [before, after])
      ctx.onCleanup(
        `Forgejo ${r}`,
        async () => void (await f.api('DELETE', `/repos/${USER}/${r}`)),
      )
    for (const r of [orgA, orgB])
      ctx.onCleanup(
        `Forgejo ${org}/${r}`,
        async () => void (await f.api('DELETE', `/repos/${org}/${r}`)),
      )

    const targets = [
      { owner: USER, repo: before },
      { owner: USER, repo: after },
      { owner: org, repo: orgA },
      { owner: org, repo: orgB },
    ]
    got.length = 0
    for (const t of targets) await commit(f, t.repo, 'hook.txt', 'h\n', t.owner)
    await until(() => got.length >= targets.length, { timeout: 30_000 })
    await Bun.sleep(3000)

    const seen = targets.map((t) => {
      const full = `${t.owner}/${t.repo}`
      const n = got.filter((d) => {
        try {
          return (
            (JSON.parse(d.body) as { repository?: { full_name?: string } })
              .repository?.full_name === full
          )
        } catch {
          return false
        }
      }).length
      return { full, n }
    })
    for (const s of seen) ctx.log.line(`${s.full}: ${s.n} deliveries`)

    const sample = got[0] as Delivery | undefined
    const names = sample
      ? Object.keys(sample.headers)
          .filter((h) => h.startsWith('x-'))
          .sort()
      : []
    ctx.log.line(`headers: ${names.join(', ')}`)
    const verify = (d: Delivery) => {
      const sig =
        d.headers['x-forgejo-signature'] ?? d.headers['x-gitea-signature'] ?? ''
      const want = createHmac('sha256', secret).update(d.body).digest('hex')
      return (
        sig.length === want.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(want))
      )
    }
    const allSigned = got.length > 0 && got.every(verify)
    const ids = got.map(
      (d) =>
        d.headers['x-forgejo-delivery'] ?? d.headers['x-gitea-delivery'] ?? '',
    )
    const uuid =
      ids.every((i) => /^[0-9a-f-]{36}$/.test(i)) &&
      new Set(ids).size === ids.length
    ctx.log.line(
      `HMAC-SHA256 of the body matches x-forgejo-signature on all: ${allSigned}; delivery ids are distinct UUIDs: ${uuid}`,
    )

    const userAll = seen.slice(0, 2).every((s) => s.n >= 1)
    const orgAll = seen.slice(2).every((s) => s.n >= 1)
    const doubled = seen.some((s) => s.n > 1)
    return {
      outcome: userAll && orgAll && allSigned && uuid ? 'pass' : 'finding',
      summary: `User hook (HTTP ${userHook.status}) fired for ${seen.slice(0, 2).filter((s) => s.n).length}/2 user repos (one made before, one after the hook); org hook (HTTP ${orgHook.status}) for ${seen.slice(2).filter((s) => s.n).length}/2 org repos.${doubled ? ' Some pushes were delivered more than once.' : ''} Signature: HMAC-SHA256 hex of the raw body in x-forgejo-signature (and x-gitea-signature), valid on every delivery: ${allSigned}. Delivery id x-forgejo-delivery, a distinct UUID each: ${uuid}.`,
      consequence:
        userAll && orgAll
          ? 'For Forgejo/Codeberg, one user-level hook (plus one per org the person administers) could replace per-repository hooks; it also fires for repos the person did not import, so the receiver must ignore unknown repos. v1 keeps per-repository hooks (one code path with GitLab, and least access); the user hook is a later optimization. Dedupe on x-forgejo-delivery, verify x-forgejo-signature.'
          : 'User/org hooks do not cover every repository: keep per-repository hooks, as on GitLab.',
      risk: 'Forgejo user or org hook',
    }
  },
}
