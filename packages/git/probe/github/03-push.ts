import { clean, commitFile } from '../lib'
import type { Scenario } from '../lib'

export const push: Scenario = {
  id: 'github-03-push',
  title: 'Code Storage to GitHub with a push',
  async run(ctx) {
    const { name } = await ctx.pair('push')
    const dir = await ctx.cloneStore(name)

    const samples: Array<{ push: number; arrive: number }> = []
    for (let i = 0; i < 3; i++) {
      const sha = commitFile(dir, 'pushed.txt', `push ${i}\n`)
      const r = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
      ctx.log.line(
        `push ${i + 1} (${r.ms} ms) exit ${r.code}: ${clean(r.out) || '(no output)'}`,
      )
      if (!r.ok)
        return {
          outcome: 'fail',
          summary: `A plain fast-forward push to Code Storage was refused: ${clean(r.out)}`,
          consequence: 'Forwarded pushes do not work; Phase 2 is blocked.',
        }
      const t = Date.now()
      const arrived = await ctx.ghWaitFor(name, 'main', sha, 60_000)
      if (!arrived.value) {
        ctx.log.line(
          `not on GitHub after 60 s; GitHub main is ${ctx.ghHead(name)}`,
        )
        return {
          outcome: 'fail',
          summary:
            'A push accepted by Code Storage did not reach GitHub in 60 s.',
          consequence:
            'The forward is asynchronous or broken; find out which before Phase 2.',
        }
      }
      samples.push({ push: r.ms, arrive: Date.now() - t })
      ctx.log.line(`on GitHub ${Date.now() - t} ms after the push returned`)
    }
    const sync = samples.every((s) => s.arrive < 1500)
    return {
      outcome: 'pass',
      summary: `Pushes took ${samples.map((s) => s.push).join(', ')} ms and were on GitHub ${samples
        .map((s) => s.arrive)
        .join(', ')} ms after the push returned.`,
      consequence: sync
        ? 'The forward to GitHub happens inside the push: when git says ok, GitHub has it.'
        : 'The forward to GitHub lags the push; a reader of GitHub can briefly see the old state.',
    }
  },
}
