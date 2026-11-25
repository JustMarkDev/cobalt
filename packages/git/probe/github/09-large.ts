import { GITHUB_OWNER, codeOf, errorOf, sh, until } from '../lib'

const during = new Set<string>()
import type { Ctx, Scenario } from '../lib'

const TIMEOUT = 20 * 60_000
const ROOT = 'e83c5163316f89bfbde7d9ab23ca2e25604af290'

async function firstSync(
  ctx: Ctx,
  name: string,
  branch: string,
  label: string,
) {
  const t = Date.now()
  const seen = new Set<string>()
  const note = (what: string, answer: string) => {
    const key = `${what}: ${answer.split(' body=')[0]}`
    if (seen.has(key)) return
    seen.add(key)
    during.add(key)
    ctx.log.line(`${label} during sync, ${key}`)
  }
  const r = await until(
    async () => {
      let has = false
      try {
        has = (await ctx.storeBranches(name)).has(branch)
      } catch (e) {
        note('branches.list', errorOf(e))
        has = false
        if (codeOf(e) !== 'sync_in_progress') throw e
      }
      if (has) return true
      for (const [what, call] of [
        ['upstream.pull', () => ctx.storePull(name)],
        [
          'commits.get',
          () => ctx.pierre.repos.commits.get({ repo_name: name, ref: branch }),
        ],
      ] as const) {
        try {
          await call()
          note(what, 'ok')
        } catch (e) {
          note(what, errorOf(e))
        }
      }
      return false
    },
    { timeout: TIMEOUT, every: 1000 },
  )
  const ms = Date.now() - t
  ctx.log.line(
    r.value
      ? `${label}: ${branch} present after ${(ms / 1000).toFixed(1)} s`
      : `${label}: nothing after ${TIMEOUT / 60_000} min (last: ${'last' in r ? r.last : ''})`,
  )
  return r.value ? ms : undefined
}

export const large: Scenario = {
  id: 'github-09-large',
  title: 'Large repository: first sync time',
  async run(ctx) {
    const pub = ctx.name('large-public')
    const fork = ctx.name('large-app')

    let publicAnswer = ''
    try {
      const ms = await ctx.storeCreate(
        pub,
        { owner: 'git', name: 'git', access: 'public' },
        'master',
      )
      publicAnswer = `accepted in ${ms} ms`
    } catch (e) {
      publicAnswer = errorOf(e)
    }
    ctx.log.line(`public mode git/git: ${publicAnswer}`)

    const forked = sh([
      'gh',
      'repo',
      'fork',
      'git/git',
      '--clone=false',
      '--default-branch-only',
      '--fork-name',
      fork,
    ])
    if (!forked.ok) throw new Error(`gh repo fork failed: ${forked.out}`)
    ctx.ghOwned(fork)
    const ready = await until(() => ctx.ghHead(fork, 'master'), {
      timeout: 120_000,
      every: 3000,
    })
    ctx.log.line(
      `fork ${GITHUB_OWNER}/${fork} ready: ${Boolean(ready.value)} (${ready.ms} ms)`,
    )
    const appMs = await ctx.storeCreate(
      fork,
      { owner: GITHUB_OWNER, name: fork },
      'master',
    )
    ctx.log.line(`App mode fork: accepted in ${appMs} ms`)

    const [pubMs, appSync] = await Promise.all([
      publicAnswer.startsWith('accepted')
        ? firstSync(ctx, pub, 'master', 'public mode')
        : undefined,
      firstSync(ctx, fork, 'master', 'App mode'),
    ])
    let history = 'not checked'
    if (appSync !== undefined) {
      const c = await ctx.pierre.repos.commits.list({
        repo_name: fork,
        ref: 'master',
        limit: 1,
      })
      ctx.log.line(`App mode head commit ${c.body.commits[0]?.sha.slice(0, 7)}`)
      try {
        const root = await ctx.pierre.repos.commits.get({
          repo_name: fork,
          ref: ROOT,
        })
        const f = await ctx.pierre.repos.files.get({
          repo_name: fork,
          path: 'README',
          ref: ROOT,
        })
        history = `root commit ${root.commit.sha.slice(0, 7)} (${root.commit.date}) readable, README at it ${f.status === 200 ? `${(await f.text()).length} bytes` : `HTTP ${f.status}`}`
      } catch (e) {
        history = `root commit not readable: ${errorOf(e)}`
      }
      ctx.log.line(`history: ${history}`)
    }
    const fmt = (ms?: number) =>
      ms === undefined ? 'did not finish' : `${(ms / 1000).toFixed(0)} s`
    return {
      outcome: appSync === undefined ? 'fail' : 'pass',
      summary: `git/git first sync: App mode ${fmt(appSync)}, public mode ${
        publicAnswer.startsWith('accepted')
          ? fmt(pubMs)
          : `refused (${publicAnswer})`
      }. History: ${history}. Answers during the first sync: ${[...during].join('; ') || 'none'}.`,
      consequence:
        'The import job must not wait inline for a large first sync: it records the job item as syncing and completes it when the default branch appears (polled by the workflow), with a timeout well above this time.',
    }
  },
}
