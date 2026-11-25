// 2. GitHub to Code Storage: does a commit arrive by itself, and how fast does
// it arrive after upstream.pull?
import type { Scenario } from '../lib'

const UNPROMPTED_WAIT = 45_000

export const pull: Scenario = {
  id: 'github-02-pull',
  title: 'GitHub to Code Storage with upstream.pull',
  async run(ctx) {
    const { name } = await ctx.pair('pull')

    const first = ctx.ghCommit(name, 'one.txt', 'one\n')
    ctx.log.line(
      `GitHub commit ${first}; waiting ${UNPROMPTED_WAIT / 1000} s without a pull`,
    )
    const alone = await ctx.storeWaitFor(name, 'main', first, UNPROMPTED_WAIT)
    ctx.log.line(
      alone.value
        ? `arrived without a pull after ${alone.ms} ms`
        : 'did not arrive without a pull',
    )

    const samples: Array<number> = []
    let sha = first
    for (let i = 0; i < 3; i++) {
      if (i > 0 || alone.value)
        sha = ctx.ghCommit(name, 'one.txt', `pull ${i}\n`)
      const t = Date.now()
      const p = await ctx.storePullSettled(name)
      ctx.log.line(
        `upstream.pull answered in ${p.ms} ms (${p.busy} busy retries): "${p.message}"`,
      )
      const seen = await ctx.storeWaitFor(name, 'main', sha, 60_000)
      if (!seen.value) {
        ctx.log.line(
          `commit ${sha} not in the store 60 s after the pull: ${seen.last}`,
        )
        return {
          outcome: 'fail',
          summary: 'A commit did not arrive within 60 s of upstream.pull.',
          consequence:
            'The webhook-driven pull is not enough; find out why before Phase 2.',
          risk: 'none',
        }
      }
      samples.push(Date.now() - t)
      ctx.log.line(
        `sample ${i + 1}: commit visible ${Date.now() - t} ms after the pull call`,
      )
    }
    const sorted = [...samples].sort((a, b) => a - b)
    return {
      outcome: 'pass',
      summary: `${
        alone.value
          ? `A GitHub commit arrived without a pull after ${alone.ms} ms.`
          : `A GitHub commit did not arrive within ${UNPROMPTED_WAIT / 1000} s without a pull.`
      } After upstream.pull: ${samples.join(', ')} ms (median ${sorted[1]} ms).`,
      consequence: alone.value
        ? 'Code Storage notices GitHub changes by itself; the Cobalt webhook is a speed-up, not a requirement.'
        : 'Code Storage does not notice GitHub changes by itself while the App webhook points at Cobalt: the /hooks/github receiver must call upstream.pull on every push (Phase 2), with the lazy pull and cron as fallback.',
    }
  },
}
