import { clean, commitFile } from '../lib'
import type { Ctx, Scenario } from '../lib'

function contains(ctx: Ctx, repo: string, head: string, ancestor: string) {
  if (head === ancestor) return true
  const c = ctx.gh<{ status: string }>([
    `repos/JustMarkDev/${repo}/compare/${ancestor}...${head}`,
  ])
  return c.status === 'ahead' || c.status === 'identical'
}

export const divergence: Scenario = {
  id: 'github-04-divergence',
  title: 'Divergence: GitHub moved, push to Code Storage without a pull',
  async run(ctx) {
    const { name, main } = await ctx.pair('diverge')
    const dir = await ctx.cloneStore(name)

    const theirs = ctx.ghCommit(name, 'theirs.txt', 'made on GitHub\n')
    ctx.log.line(
      `GitHub moved: main ${main.slice(0, 7)} -> ${theirs.slice(0, 7)}; no pull`,
    )
    const storeBefore = await ctx.storeHead(name)
    ctx.log.line(`store main before the push: ${storeBefore?.slice(0, 7)}`)

    const ours = commitFile(dir, 'ours.txt', 'made through Code Storage\n')
    const r = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
    ctx.log.line(
      `push of ${ours.slice(0, 7)} (${r.ms} ms) exit ${r.code}:\n${clean(r.out)}`,
    )

    await Bun.sleep(10_000)
    const ghMain = ctx.ghHead(name)!
    const storeMain = await ctx.storeHead(name)
    const theirsKept = contains(ctx, name, ghMain, theirs)
    const oursOnGithub = (() => {
      try {
        return contains(ctx, name, ghMain, ours)
      } catch {
        return false
      }
    })()
    ctx.log.line(
      `10 s later: GitHub main ${ghMain.slice(0, 7)} (GitHub commit kept: ${theirsKept}, pushed commit there: ${oursOnGithub}); store main ${storeMain?.slice(0, 7)}`,
    )

    const p = await ctx.storePullSettled(name)
    ctx.log.line(`upstream.pull: "${p.message}"`)
    await Bun.sleep(5000)
    const storeAfterPull = await ctx.storeHead(name)
    ctx.log.line(`store main after the pull: ${storeAfterPull?.slice(0, 7)}`)

    const again = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
    ctx.log.line(
      `same push after the pull, exit ${again.code}:\n${clean(again.out)}`,
    )

    if (r.ok && !theirsKept)
      return {
        outcome: 'finding',
        summary: `STOP: the push was accepted and GitHub's commit ${theirs.slice(0, 7)} was overwritten on GitHub (main is now ${ghMain.slice(0, 7)}).`,
        consequence:
          'A push after divergence overwrites the provider silently. The plan must change: the git proxy has to pull and check fast-forward before forwarding.',
        risk: 'push after the provider moved',
      }
    if (r.ok && oursOnGithub)
      return {
        outcome: 'pass',
        summary: `The push was accepted and both commits are on GitHub (main ${ghMain.slice(0, 7)}): Code Storage merged or rebased it.`,
        consequence:
          'No refusal to translate; document that a push after divergence is merged.',
        risk: 'push after the provider moved',
      }
    if (r.ok)
      return {
        outcome: 'finding',
        summary: `The push was accepted by Code Storage but did not reach GitHub (GitHub main ${ghMain.slice(0, 7)}, store main ${storeMain?.slice(0, 7)}, after a pull ${storeAfterPull?.slice(0, 7)}).`,
        consequence:
          'A push after divergence is accepted and then lost or left diverged without telling the pusher. The proxy must pull before forwarding a push.',
        risk: 'push after the provider moved',
      }
    return {
      outcome: 'pass',
      summary: `The push was refused (exit ${r.code}). Git said: ${clean(r.out)
        .split('\n')
        .filter((l) => /^\s*!|^error:|^remote:/.test(l))
        .join(
          ' | ',
        )}. GitHub kept its commit; store main stayed ${storeMain?.slice(0, 7)}, so the refusal came from GitHub during the forward, not from the store's own ref.`,
      consequence:
        'Nothing is overwritten. The git proxy should translate this answer into "the provider has newer commits: pull first", and can pull before forwarding to make it rarer.',
      risk: 'push after the provider moved',
    }
  },
}
