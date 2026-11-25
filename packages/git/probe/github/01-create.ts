// 1. Create with an upstream: how long the first sync takes, and what the
// other calls answer while it runs.
import { GITHUB_OWNER, codeOf, errorOf } from '../lib'
import type { Scenario } from '../lib'

export const create: Scenario = {
  id: 'github-01-create',
  title: 'Create with an upstream: first sync and sync_in_progress',
  async run(ctx) {
    const name = ctx.name('create')
    ctx.ghCreate(name)
    const main = ctx.ghHead(name)
    ctx.log.line(`GitHub main ${main}`)

    // Without default_branch first: the docs say it is taken from GitHub.
    let withoutDefault = 'accepted'
    try {
      await ctx.pierre.repos.create({
        repo_name: name,
        upstream: { provider: 'github', owner: GITHUB_OWNER, name },
      })
      ctx.onCleanup(`Code Storage ${name} (no default)`, () =>
        ctx.storeDelete(name),
      )
    } catch (e) {
      withoutDefault = errorOf(e)
    }
    ctx.log.line(`repos.create without default_branch: ${withoutDefault}`)
    if (withoutDefault === 'accepted') await ctx.storeDelete(name)

    const accepted = await ctx.storeCreate(name, { owner: GITHUB_OWNER, name })
    ctx.log.line(`repos.create accepted in ${accepted} ms`)

    // Ask everything we will ask in production while the first sync runs, and
    // write down each distinct answer.
    const answers = new Map<string, number>()
    const note = (what: string, a: string) => {
      const key = `${what}: ${a}`
      if (!answers.has(key)) {
        answers.set(key, Date.now() - t0)
        ctx.log.line(`${key} (first seen)`)
      }
    }
    const t0 = Date.now()
    let firstSync: number | undefined
    while (Date.now() - t0 < 120_000) {
      try {
        const b = await ctx.storeBranches(name)
        note(
          'branches.list',
          b.size ? `branches ${[...b.keys()].join(',')}` : 'empty',
        )
        if (b.get('main') === main) {
          firstSync = Date.now() - t0
          break
        }
      } catch (e) {
        note('branches.list', errorOf(e))
      }
      try {
        await ctx.pierre.repos.commits.get({ repo_name: name, ref: 'main' })
        note('commits.get main', 'ok')
      } catch (e) {
        note('commits.get main', errorOf(e))
      }
      try {
        const r = await ctx.storePull(name)
        note('upstream.pull', `ok: ${r.message}`)
      } catch (e) {
        note('upstream.pull', errorOf(e))
      }
      await Bun.sleep(250)
    }

    // A second create of the same name with the same upstream, then with another.
    try {
      await ctx.pierre.repos.create({
        repo_name: name,
        upstream: { provider: 'github', owner: GITHUB_OWNER, name },
      })
      ctx.log.line('repos.create again, same upstream: accepted (idempotent)')
    } catch (e) {
      ctx.log.line(`repos.create again, same upstream: ${errorOf(e)}`)
    }
    try {
      await ctx.pierre.repos.create({
        repo_name: name,
        upstream: {
          provider: 'github',
          owner: GITHUB_OWNER,
          name: `${name}-other`,
        },
      })
      ctx.log.line('repos.create again, other upstream: accepted')
    } catch (e) {
      ctx.log.line(
        `repos.create again, other upstream: ${errorOf(e)} (code ${codeOf(e)})`,
      )
    }

    const busy = [...answers.keys()].filter((k) =>
      k.includes('sync_in_progress'),
    )
    if (firstSync === undefined)
      return {
        outcome: 'fail',
        summary: 'The first sync did not arrive in 120 s.',
        consequence:
          'Import cannot assume a quick first sync: it must wait asynchronously.',
      }
    return {
      outcome: withoutDefault === 'accepted' ? 'pass' : 'finding',
      summary: `${
        withoutDefault === 'accepted'
          ? ''
          : `Without default_branch, repos.create answers: ${withoutDefault.split(' body=')[0]}. With it: `
      }repos.create took ${accepted} ms; main arrived ${firstSync} ms later. ${
        busy.length
          ? `During the sync: ${busy.join('; ')}.`
          : 'No call answered sync_in_progress during the sync.'
      }`,
      consequence:
        (withoutDefault === 'accepted'
          ? ''
          : 'GitStores.provision must always send default_branch with an upstream (Phase 1 makes it required in the type), read from the provider first; a 412 github_repository_inaccessible is not proof the App lacks access. ') +
        'The import job waits for the first sync by polling the default branch, and retries any call that answers 409 sync_in_progress.',
    }
  },
}
