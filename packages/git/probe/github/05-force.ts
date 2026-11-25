import { clean, commitFile, sh } from '../lib'
import type { Scenario } from '../lib'

export const force: Scenario = {
  id: 'github-05-force',
  title: 'Force push on GitHub and on Code Storage',
  async run(ctx) {
    const { name } = await ctx.pair('force')
    const notes: Array<string> = []

    const a1 = ctx.ghCommit(name, 'a.txt', 'a1\n')
    await ctx.storePullSettled(name)
    const s1 = await ctx.storeWaitFor(name, 'main', a1, 60_000)
    ctx.log.line(`setup: store has ${a1.slice(0, 7)}: ${Boolean(s1.value)}`)
    const gdir = ctx.cloneGithub(name)
    sh(['git', 'reset', '--quiet', '--hard', 'HEAD~1'], { cwd: gdir })
    const rewritten = commitFile(gdir, 'a.txt', 'rewritten on GitHub\n')
    const gp = ctx.gitGithub(gdir, ['push', '--force', 'origin', 'HEAD:main'])
    ctx.log.line(
      `force push to GitHub ${rewritten.slice(0, 7)} exit ${gp.code}: ${clean(gp.out)}`,
    )
    const pull = await ctx.storePullSettled(name)
    ctx.log.line(`upstream.pull: "${pull.message}"`)
    const followed = await ctx.storeWaitFor(name, 'main', rewritten, 60_000)
    const aOk = Boolean(followed.value)
    ctx.log.line(
      aOk
        ? `store followed the GitHub force push after ${followed.ms} ms`
        : `store did NOT follow: main is ${(await ctx.storeHead(name))?.slice(0, 7)}`,
    )
    notes.push(
      aOk
        ? `GitHub force push followed by the store (${followed.ms} ms after the pull)`
        : 'GitHub force push NOT followed by the store',
    )

    const sdir = await ctx.cloneStore(name)
    sh(['git', 'reset', '--quiet', '--hard', 'HEAD~1'], { cwd: sdir })
    const forced = commitFile(sdir, 'b.txt', 'rewritten through Code Storage\n')
    const sp = await ctx.gitStore(name, sdir, [
      'push',
      '--force',
      'origin',
      'HEAD:main',
    ])
    ctx.log.line(
      `force push to Code Storage ${forced.slice(0, 7)} exit ${sp.code}: ${clean(sp.out)}`,
    )
    const onGithub = await ctx.ghWaitFor(name, 'main', forced, 60_000)
    const bOk = sp.ok && Boolean(onGithub.value)
    ctx.log.line(
      bOk
        ? `GitHub followed after ${onGithub.ms} ms`
        : `GitHub main is ${ctx.ghHead(name)?.slice(0, 7)}, store main ${(await ctx.storeHead(name))?.slice(0, 7)}`,
    )
    notes.push(
      bOk
        ? 'Code Storage force push forwarded to GitHub'
        : sp.ok
          ? 'Code Storage accepted the force push but GitHub did not follow'
          : `Code Storage refused the force push: ${clean(sp.out).split('\n').slice(-2).join(' | ')}`,
    )

    return {
      outcome: aOk && bOk ? 'pass' : 'finding',
      summary: `${notes.join('. ')}.`,
      consequence:
        aOk && bOk
          ? 'Force pushes propagate both ways. Cobalt branch protection (the no-force-push ref policy in remote.ts) is what stops them, not the provider.'
          : 'Force pushes do not propagate in one direction: document it and offer a manual re-sync (detach and re-provision).',
      risk: 'force push and branch deletion',
    }
  },
}
