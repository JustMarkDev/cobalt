// 6. Deleting branches and tags, in both directions.
import { GITHUB_OWNER, clean, until } from '../lib'
import type { Scenario } from '../lib'

export const deletion: Scenario = {
  id: 'github-06-delete',
  title: 'Branch and tag deletion in both directions',
  async run(ctx) {
    const { name, main } = await ctx.pair('delete')
    const found: Record<string, boolean> = {}

    // GitHub -> Code Storage
    ctx.gh(['-X', 'POST', `repos/${GITHUB_OWNER}/${name}/git/refs`], {
      ref: 'refs/heads/gh-branch',
      sha: main,
    })
    ctx.gh(['-X', 'POST', `repos/${GITHUB_OWNER}/${name}/git/refs`], {
      ref: 'refs/tags/gh-tag',
      sha: main,
    })
    await ctx.storePullSettled(name)
    const arrived = await until(
      async () =>
        (await ctx.storeBranches(name)).has('gh-branch') &&
        (await ctx.storeTags(name)).has('gh-tag'),
      { timeout: 60_000 },
    )
    ctx.log.line(
      `GitHub branch and tag in the store: ${Boolean(arrived.value)} (${arrived.ms} ms)`,
    )
    ctx.gh([
      '-X',
      'DELETE',
      `repos/${GITHUB_OWNER}/${name}/git/refs/heads/gh-branch`,
    ])
    ctx.gh([
      '-X',
      'DELETE',
      `repos/${GITHUB_OWNER}/${name}/git/refs/tags/gh-tag`,
    ])
    await ctx.storePullSettled(name)
    const gone = await until(
      async () => {
        const b = (await ctx.storeBranches(name)).has('gh-branch')
        const t = (await ctx.storeTags(name)).has('gh-tag')
        found.storeBranchGone = !b
        found.storeTagGone = !t
        return !b && !t
      },
      { timeout: 45_000 },
    )
    ctx.log.line(
      `after deleting on GitHub and a pull: branch gone ${found.storeBranchGone}, tag gone ${found.storeTagGone} (${gone.ms} ms)`,
    )

    // Code Storage -> GitHub
    const dir = await ctx.cloneStore(name)
    const p = await ctx.gitStore(name, dir, [
      'push',
      'origin',
      'HEAD:refs/heads/cs-branch',
      'HEAD:refs/tags/cs-tag',
    ])
    ctx.log.line(
      `push branch and tag to the store exit ${p.code}: ${clean(p.out)}`,
    )
    const there = await until(
      () => ctx.ghHead(name, 'cs-branch') && ctx.ghTag(name, 'cs-tag'),
      { timeout: 60_000 },
    )
    ctx.log.line(
      `branch and tag on GitHub: ${Boolean(there.value)} (${there.ms} ms)`,
    )
    const d = await ctx.gitStore(name, dir, [
      'push',
      'origin',
      '--delete',
      'refs/heads/cs-branch',
      'refs/tags/cs-tag',
    ])
    ctx.log.line(`push --delete to the store exit ${d.code}: ${clean(d.out)}`)
    const away = await until(
      () => {
        found.ghBranchGone = !ctx.ghHead(name, 'cs-branch')
        found.ghTagGone = !ctx.ghTag(name, 'cs-tag')
        return found.ghBranchGone && found.ghTagGone
      },
      { timeout: 45_000 },
    )
    ctx.log.line(
      `on GitHub after the delete: branch gone ${found.ghBranchGone}, tag gone ${found.ghTagGone} (${away.ms} ms)`,
    )

    const all =
      found.storeBranchGone &&
      found.storeTagGone &&
      found.ghBranchGone &&
      found.ghTagGone
    const missing = Object.entries(found)
      .filter(([, v]) => !v)
      .map(([k]) => k)
    return {
      outcome: all ? 'pass' : 'finding',
      summary: all
        ? 'Branch and tag deletions propagate both ways (GitHub to store after a pull, store to GitHub with the push).'
        : `Not every deletion propagated: ${missing.join(', ')} stayed.`,
      consequence: all
        ? 'Nothing to build for deletions; the webhook-driven pull carries them.'
        : 'Document which deletions do not propagate; a full re-sync (detach and re-provision) is the manual fix.',
      risk: 'force push and branch deletion',
    }
  },
}
