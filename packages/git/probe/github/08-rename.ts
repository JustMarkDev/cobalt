import { GITHUB_OWNER, clean, commitFile, errorOf, sh } from '../lib'
import type { Ctx, Scenario } from '../lib'

const lastLines = (out: string) =>
  clean(out)
    .split('\n')
    .filter((l) => /^remote:|^fatal:|^\s*!/.test(l))
    .map((l) => l.trim())
    .join(' | ')

async function tryPush(
  ctx: Ctx,
  name: string,
  to: string,
  dir: string,
  label: string,
) {
  const sha = commitFile(dir, `${label}.txt`, `${label}\n`)
  const p = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
  const landed =
    p.ok && Boolean((await ctx.ghWaitFor(to, 'main', sha, 30_000)).value)
  ctx.log.line(
    `push ${label}: exit ${p.code}, on GitHub ${landed}: ${lastLines(p.out) || '(no remote lines)'}`,
  )
  if (!p.ok) sh(['git', 'reset', '--quiet', '--hard', 'HEAD~1'], { cwd: dir })
  return { ok: landed, said: lastLines(p.out) }
}

export const rename: Scenario = {
  id: 'github-08-rename',
  title: 'GitHub repository rename',
  async run(ctx) {
    const { name } = await ctx.pair('rename')
    const dir = await ctx.cloneStore(name)
    const to = `${name}-renamed`
    const r = sh([
      'gh',
      'repo',
      'rename',
      to,
      '-R',
      `${GITHUB_OWNER}/${name}`,
      '--yes',
    ])
    if (!r.ok) throw new Error(`gh repo rename failed: ${r.out}`)
    ctx.ghRenamed(name, to)
    ctx.log.line(`renamed on GitHub to ${to}`)

    const early = await tryPush(ctx, name, to, dir, 'right-after-rename')

    const sha = ctx.ghCommit(to, 'after-rename.txt', 'x\n')
    let pullAnswer: string
    try {
      pullAnswer = `ok: ${(await ctx.storePullSettled(name)).message}`
    } catch (e) {
      pullAnswer = errorOf(e)
    }
    const pulled = await ctx.storeWaitFor(name, 'main', sha, 60_000)
    ctx.log.line(
      `upstream.pull after the rename: ${pullAnswer}; GitHub commit in the store: ${Boolean(pulled.value)}`,
    )
    sh(['git', 'pull', '--quiet', '--rebase'], { cwd: dir })
    await ctx.gitStore(name, dir, [
      'pull',
      '--quiet',
      '--rebase',
      'origin',
      'main',
    ])

    await Bun.sleep(30_000)
    const late = await tryPush(ctx, name, to, dir, 'thirty-seconds-later')

    let relink: string
    try {
      await ctx.pierre.repos.upstream.delete({ repo_name: name })
      await ctx.pierre.repos.create({
        repo_name: name,
        default_branch: 'main',
        upstream: { provider: 'github', owner: GITHUB_OWNER, name: to },
      })
      relink = `ok, upstream now ${JSON.stringify((await ctx.pierre.repos.get({ repo_name: name })).upstream)}`
    } catch (e) {
      relink = `FAILED: ${errorOf(e)}`
    }
    ctx.log.line(
      `relink (upstream.delete, then repos.create with the new name): ${relink}`,
    )
    const relinked = relink.startsWith('ok')
      ? await tryPush(ctx, name, to, dir, 'after-relink')
      : { ok: false, said: '' }
    const sha2 = ctx.ghCommit(to, 'after-relink.txt', 'z\n')
    await ctx.storePullSettled(name).catch(() => undefined)
    const pulled2 = await ctx.storeWaitFor(name, 'main', sha2, 30_000)
    ctx.log.line(`pull after relink: ${Boolean(pulled2.value)}`)

    const allOld = early.ok && late.ok && Boolean(pulled.value)
    return {
      outcome: allOld ? 'pass' : 'finding',
      summary: `Through the old name after a rename: pull ${pulled.value ? 'works' : 'fails'}; push right after ${early.ok ? 'works' : `fails (${early.said})`}; push 30 s later ${late.ok ? 'works' : `fails (${late.said})`}. Relinking the same store to the new name: ${relink.split(' body=')[0]}, then push ${relinked.ok ? 'works' : 'fails'} and pull ${pulled2.value ? 'works' : 'fails'}.`,
      consequence: `${allOld ? "GitHub's redirect keeps the old name working, but it breaks as soon as someone reuses the old name. " : 'The old name is not reliable after a rename. '}${relinked.ok && pulled2.value ? 'Plan B verified: on the repository renamed/transferred webhook, call upstream.delete and repos.create with the new owner/name on the same store (history kept). The proxy translates 403 "GitHub App not installed or repo not found" into "the provider repository moved; reconnecting".' : 'Relinking did not work: re-provision into a new store on rename.'}`,
      risk: 'rename or transfer',
    }
  },
}
