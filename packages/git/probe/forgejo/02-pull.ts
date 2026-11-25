// Forgejo 2. A push on the provider with no webhook: does it arrive by itself,
// and how fast after upstream.pull?
import { pairForgejo } from './common'
import { commit, forgejo, pat } from './env'
import type { Scenario } from '../lib'

const ALONE = 60_000

export const forgejoPull: Scenario = {
  id: 'forgejo-02-pull',
  title: 'Generic mode: pull after a provider push, no webhook',
  async run(ctx) {
    const f = await forgejo()
    const p = await pairForgejo(ctx, 'fj-pull', await pat(f))
    const first = await commit(f, p.name, 'one.txt', 'one\n')
    const alone = await ctx.storeWaitFor(p.name, 'main', first, ALONE)
    ctx.log.line(
      alone.value
        ? `arrived alone after ${alone.ms} ms`
        : `not arrived alone in ${ALONE / 1000} s`,
    )
    const samples: Array<number> = []
    for (let i = 0; i < 3; i++) {
      const sha =
        i === 0 && !alone.value
          ? first
          : await commit(f, p.name, 'one.txt', `n${i}\n`)
      const t = Date.now()
      await ctx.storePullSettled(p.name)
      const seen = await ctx.storeWaitFor(p.name, 'main', sha, 60_000)
      if (!seen.value)
        return {
          outcome: 'fail',
          summary:
            'A Forgejo commit did not arrive within 60 s of upstream.pull.',
          consequence: 'Generic pulls are broken; check before Phase 3.',
        }
      samples.push(Date.now() - t)
      ctx.log.line(`sample ${i + 1}: ${Date.now() - t} ms after the pull call`)
    }
    return {
      outcome: 'pass',
      summary: `${alone.value ? `A Forgejo commit arrived without a pull after ${alone.ms} ms.` : `Without a pull nothing arrived in ${ALONE / 1000} s.`} After upstream.pull: ${samples.join(', ')} ms.`,
      consequence: alone.value
        ? 'Code Storage polls generic upstreams by itself; webhooks only make it faster.'
        : 'Generic upstreams need Cobalt to call upstream.pull: per-repository webhooks, plus the lazy pull and slow cron as fallback (as planned).',
    }
  },
}
