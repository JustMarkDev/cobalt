import { clean, commitFile, sh, until } from '../lib'
import { pairForgejo } from './common'
import { commit, forgejo, head, pat } from './env'
import type { Scenario } from '../lib'

export const forgejoPush: Scenario = {
  id: 'forgejo-03-push',
  title: 'Generic mode: forwarded push, divergence, force push, deletion',
  async run(ctx) {
    const f = await forgejo()
    const p = await pairForgejo(ctx, 'fj-push', await pat(f))
    const dir = await ctx.cloneStore(p.name)
    const notes: Array<string> = []

    const a = commitFile(dir, 'a.txt', 'a\n')
    const r1 = await ctx.gitStore(p.name, dir, ['push', 'origin', 'HEAD:main'])
    const t1 = Date.now()
    const landed =
      r1.ok &&
      Boolean(
        (
          await until(async () => (await head(f, p.name)) === a, {
            timeout: 60_000,
          })
        ).value,
      )
    ctx.log.line(
      `push exit ${r1.code}: ${clean(r1.out)}; on Forgejo ${landed} (${Date.now() - t1} ms after)`,
    )
    notes.push(
      landed
        ? `push forwarded (on Forgejo ${Date.now() - t1} ms after git returned)`
        : `push NOT forwarded: ${clean(r1.out)}`,
    )

    const theirs = await commit(f, p.name, 'theirs.txt', 'x\n')
    const ours = commitFile(dir, 'ours.txt', 'y\n')
    const r2 = await ctx.gitStore(p.name, dir, ['push', 'origin', 'HEAD:main'])
    await Bun.sleep(5000)
    const fjMain = await head(f, p.name)
    ctx.log.line(
      `push after divergence exit ${r2.code}:\n${clean(r2.out)}\nForgejo main ${fjMain?.slice(0, 7)} (theirs ${theirs.slice(0, 7)}, ours ${ours.slice(0, 7)})`,
    )
    const overwrote = r2.ok && fjMain === ours
    notes.push(
      r2.ok
        ? overwrote
          ? 'DIVERGENCE OVERWROTE the provider'
          : 'divergent push accepted by the store but not on Forgejo'
        : `divergent push refused: ${clean(r2.out)
            .split('\n')
            .filter((l) => /^\s*!|^remote:/.test(l))
            .join(' | ')}`,
    )

    sh(['git', 'reset', '--quiet', '--hard', 'HEAD~1'], { cwd: dir })
    const forced = commitFile(dir, 'forced.txt', 'z\n')
    const r3 = await ctx.gitStore(p.name, dir, [
      'push',
      '--force',
      'origin',
      'HEAD:main',
    ])
    const followed =
      r3.ok &&
      Boolean(
        (
          await until(async () => (await head(f, p.name)) === forced, {
            timeout: 60_000,
          })
        ).value,
      )
    ctx.log.line(
      `force push exit ${r3.code}: ${clean(r3.out)}; Forgejo followed ${followed}`,
    )
    notes.push(
      followed
        ? 'force push forwarded'
        : `force push not forwarded (${clean(r3.out)})`,
    )

    const r4 = await ctx.gitStore(p.name, dir, [
      'push',
      'origin',
      'HEAD:refs/heads/side',
    ])
    const sideThere =
      r4.ok &&
      Boolean(
        (
          await until(async () => (await head(f, p.name, 'side')) === forced, {
            timeout: 30_000,
          })
        ).value,
      )
    const r5 = await ctx.gitStore(p.name, dir, [
      'push',
      'origin',
      '--delete',
      'side',
    ])
    const sideGone =
      r5.ok &&
      Boolean(
        (
          await until(async () => !(await head(f, p.name, 'side')), {
            timeout: 30_000,
          })
        ).value,
      )
    ctx.log.line(
      `branch via store: created on Forgejo ${sideThere}, deleted on Forgejo ${sideGone}`,
    )
    await f.api('POST', `/repos/probe/${p.name}/branches`, {
      new_branch_name: 'fj-side',
      old_ref_name: 'main',
    })
    await ctx.storePullSettled(p.name)
    const inStore = Boolean(
      (
        await until(
          async () => (await ctx.storeBranches(p.name)).has('fj-side'),
          { timeout: 30_000 },
        )
      ).value,
    )
    await f.api('DELETE', `/repos/probe/${p.name}/branches/fj-side`)
    await ctx.storePullSettled(p.name)
    const goneStore = Boolean(
      (
        await until(
          async () => !(await ctx.storeBranches(p.name)).has('fj-side'),
          { timeout: 30_000 },
        )
      ).value,
    )
    ctx.log.line(
      `branch via Forgejo: in store ${inStore}, deletion reached the store ${goneStore}`,
    )
    notes.push(
      `deletions: store->Forgejo ${sideThere && sideGone ? 'yes' : 'no'}, Forgejo->store ${inStore && goneStore ? 'yes' : 'no'}`,
    )

    const good = landed && !r2.ok && followed && sideGone && goneStore
    return {
      outcome: overwrote ? 'finding' : good ? 'pass' : 'finding',
      summary: `${notes.join('; ')}.`,
      consequence: overwrote
        ? 'STOP: in generic mode a push after divergence overwrites the provider.'
        : good
          ? 'Generic mode behaves like App mode: refused divergence, force pushes and deletions propagate.'
          : 'Generic mode differs from App mode in the noted points; document them.',
      risk: 'push after the provider moved',
    }
  },
}
