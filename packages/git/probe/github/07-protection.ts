import { GITHUB_OWNER, clean, commitFile } from '../lib'
import type { Scenario } from '../lib'

export const protection: Scenario = {
  id: 'github-07-protection',
  title: 'GitHub branch protection against a forwarded push',
  async run(ctx) {
    const { name } = await ctx.pair('protect', { public: true })
    ctx.gh(
      ['-X', 'PUT', `repos/${GITHUB_OWNER}/${name}/branches/main/protection`],
      {
        required_status_checks: null,
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 1 },
        restrictions: null,
      },
    )
    ctx.log.line(
      'protection on main: pull request with one approval, enforced for admins',
    )

    const dir = await ctx.cloneStore(name)
    const sha = commitFile(dir, 'direct.txt', 'pushed past the rule\n')
    const r = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
    ctx.log.line(
      `push to protected main exit ${r.code} (${r.ms} ms):\n${clean(r.out)}`,
    )
    await Bun.sleep(8000)
    const ghMain = ctx.ghHead(name)
    const storeMain = await ctx.storeHead(name)
    ctx.log.line(
      `GitHub main ${ghMain?.slice(0, 7)}, store main ${storeMain?.slice(0, 7)}`,
    )

    const side = await ctx.gitStore(name, dir, [
      'push',
      'origin',
      'HEAD:refs/heads/side',
    ])
    const sideOk =
      side.ok && Boolean((await ctx.ghWaitFor(name, 'side', sha, 30_000)).value)
    ctx.log.line(
      `push to an unprotected branch exit ${side.code}, on GitHub: ${sideOk}`,
    )

    const bypassed = ghMain === sha
    const storeAhead = !bypassed && storeMain === sha
    const lines = clean(r.out)
      .split('\n')
      .filter((l) => l.startsWith('remote:') || l.includes('!'))
    return {
      outcome: bypassed || storeAhead ? 'finding' : 'pass',
      summary: bypassed
        ? `The App bypassed the rule: the push landed on GitHub main (${sha.slice(0, 7)}).`
        : storeAhead
          ? `The push was accepted by Code Storage (exit ${r.code}) and refused by GitHub: store main is ahead of GitHub main.`
          : `The push was refused (exit ${r.code}) and neither side moved. Git said: ${lines.join(' | ') || clean(r.out)}`,
      consequence: bypassed
        ? 'Provider rules do not protect imported repositories; Cobalt branch protection is the only gate. Say so at import.'
        : storeAhead
          ? 'A rejected forward leaves the store diverged; the proxy must detect it and repair the ref.'
          : 'Provider rules are enforced on forwarded pushes. The proxy should pass the remote: lines through and name the rule (main requires a pull request).',
      risk: 'provider protection rule',
    }
  },
}
