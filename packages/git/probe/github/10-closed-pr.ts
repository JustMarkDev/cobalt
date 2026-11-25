import { GITHUB_OWNER, errorOf, sh } from '../lib'
import type { Ctx, Scenario } from '../lib'

async function hasCommit(ctx: Ctx, repo: string, sha: string) {
  try {
    await ctx.pierre.repos.commits.get({ repo_name: repo, ref: sha })
    return 'present'
  } catch (e) {
    return `absent (${errorOf(e).split(' body=')[0]})`
  }
}

function openPr(
  ctx: Ctx,
  repo: string,
  branch: string,
  main: string,
  file: string,
) {
  ctx.gh(['-X', 'POST', `repos/${GITHUB_OWNER}/${repo}/git/refs`], {
    ref: `refs/heads/${branch}`,
    sha: main,
  })
  const head = ctx.ghCommit(repo, file, `${branch} line 1\nline 2\n`, branch)
  const pr = ctx.gh<{ number: number }>(
    ['-X', 'POST', `repos/${GITHUB_OWNER}/${repo}/pulls`],
    {
      title: `probe ${branch}`,
      head: branch,
      base: 'main',
    },
  )
  return { head, number: pr.number }
}

function closeAndDelete(ctx: Ctx, repo: string, branch: string, n: number) {
  ctx.gh(['-X', 'PATCH', `repos/${GITHUB_OWNER}/${repo}/pulls/${n}`], {
    state: 'closed',
  })
  ctx.gh([
    '-X',
    'DELETE',
    `repos/${GITHUB_OWNER}/${repo}/git/refs/heads/${branch}`,
  ])
}

export const closedPr: Scenario = {
  id: 'github-10-closed-pr',
  title: 'Closed pull request with a deleted branch: head and patch',
  async run(ctx) {
    const { name, main } = await ctx.pair('closed-pr')

    const a = openPr(ctx, name, 'synced', main, 'synced.txt')
    await ctx.storePullSettled(name)
    await ctx.storeWaitFor(name, 'synced', a.head, 60_000)
    closeAndDelete(ctx, name, 'synced', a.number)
    await ctx.storePullSettled(name)
    await ctx.storeWaitFor(name, 'synced', null, 45_000)
    const aState = await hasCommit(ctx, name, a.head)
    ctx.log.line(
      `A: PR #${a.number} head ${a.head.slice(0, 7)}, synced then deleted: ${aState}`,
    )

    const b = openPr(ctx, name, 'never-synced', main, 'never.txt')
    closeAndDelete(ctx, name, 'never-synced', b.number)
    await ctx.storePullSettled(name)
    await Bun.sleep(5000)
    const bState = await hasCommit(ctx, name, b.head)
    ctx.log.line(
      `B: PR #${b.number} head ${b.head.slice(0, 7)}, never synced: ${bState}`,
    )

    const diff = sh([
      'gh',
      'api',
      `repos/${GITHUB_OWNER}/${name}/pulls/${b.number}`,
      '-H',
      'Accept: application/vnd.github.diff',
    ])
    ctx.log.line(
      `GitHub .diff of a closed PR with a deleted branch: ${diff.ok ? `${diff.out.length} bytes` : diff.out}`,
    )
    let rebuilt = 'not tried'
    if (diff.ok && diff.out) {
      try {
        const made = await ctx.pierre.repos.commits.createFromDiff({
          repo_name: name,
          target_branch: `pr/${b.number}`,
          target_is_ephemeral: true,
          base_branch: 'main',
          commit_message: `PR #${b.number} as it was on GitHub`,
          author: { name: 'cobalt-probe', email: 'probe@cobaltforge.dev' },
          diff: `${diff.out}\n`,
        })
        const sha = made.commit.commit_sha
        const file = await ctx.pierre.repos.files.get({
          repo_name: name,
          path: 'never.txt',
          ref: `pr/${b.number}`,
          ephemeral: true,
        })
        const text = await file.text()
        const same = text === 'never-synced line 1\nline 2\n'
        rebuilt = `commit ${sha.slice(0, 7)} on ephemeral pr/${b.number}; file content ${same ? 'matches' : `differs: ${JSON.stringify(text)}`}`
      } catch (e) {
        rebuilt = `FAILED: ${errorOf(e)}`
      }
    }
    ctx.log.line(`createFromDiff: ${rebuilt}`)

    const ok = diff.ok && rebuilt.includes('matches')
    return {
      outcome: ok ? 'pass' : 'finding',
      summary: `Synced then deleted: head ${aState.split(' (')[0]} in the store. Never synced: head ${bState.split(' (')[0]}. GitHub still serves the .diff (${diff.ok ? 'yes' : 'no'}); createFromDiff on an ephemeral branch: ${rebuilt}.`,
      consequence: `${aState === 'present' ? 'Commits of a deleted branch stay readable by sha for now (no promise they survive gc). ' : ''}Phase 4: check the head sha with commits.get; when absent, store the provider patch as text. ${ok ? 'Rebuilding it with createFromDiff on an ephemeral branch works and can be tried after v1.' : 'Rebuilding it with createFromDiff does not work as is.'}`,
      risk: 'fork pull requests',
    }
  },
}
