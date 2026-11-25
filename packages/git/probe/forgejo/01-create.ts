import { errorOf } from '../lib'
import { pairForgejo } from './common'
import { USER, createRepo, forgejo, head, pat } from './env'
import type { Scenario } from '../lib'

export const forgejoCreate: Scenario = {
  id: 'forgejo-01-create',
  title: 'Generic mode: create, credential, first sync',
  async run(ctx) {
    const f = await forgejo()
    const token = await pat(f)
    const p = await pairForgejo(ctx, 'fj-create', token)

    let second: string
    try {
      await ctx.pierre.repos.gitCredentials.create({
        repo_name: p.name,
        username: USER,
        password: token,
      })
      second = 'accepted'
    } catch (e) {
      second = errorOf(e).split(' body=')[0]
    }
    ctx.log.line(`a second gitCredentials.create: ${second}`)

    const bare = ctx.name('fj-nocred')
    await createRepo(f, bare)
    ctx.onCleanup(`Forgejo ${bare}`, async () => {
      await f.api('DELETE', `/repos/${USER}/${bare}`)
    })
    let bareCreate = 'accepted'
    try {
      await ctx.storeCreate(bare, {
        provider: 'forgejo',
        host: f.host,
        owner: USER,
        name: bare,
      })
    } catch (e) {
      bareCreate = errorOf(e).split(' body=')[0]
    }
    await Bun.sleep(10_000)
    let bareState: string
    try {
      bareState = `branches: ${[...(await ctx.storeBranches(bare)).keys()].join(',') || 'none'}`
    } catch (e) {
      bareState = errorOf(e).split(' body=')[0]
    }
    let barePull: string
    try {
      barePull = `ok: ${(await ctx.storePull(bare)).message}`
    } catch (e) {
      barePull = errorOf(e).split(' body=')[0]
    }
    ctx.log.line(
      `no credential: create ${bareCreate}; 10 s later ${bareState}; pull ${barePull}`,
    )
    await ctx.pierre.repos.gitCredentials.create({
      repo_name: bare,
      username: USER,
      password: token,
    })
    await ctx.storePullSettled(bare).catch(() => undefined)
    const late = await ctx.storeWaitFor(
      bare,
      'main',
      (await head(f, bare))!,
      60_000,
    )
    ctx.log.line(
      `credential added later, then a pull: synced ${Boolean(late.value)} (${late.ms} ms)`,
    )

    return {
      outcome: p.synced ? 'pass' : 'fail',
      summary: `Generic create plus credential: first sync ${p.firstSyncMs} ms after create. Second credential: ${second}. Without a credential on a private repo: create ${bareCreate}, then ${bareState}, pull ${barePull}; adding the credential and pulling ${late.value ? 'syncs it' : 'does not sync it'}.`,
      consequence:
        'Import for GitLab/Codeberg: repos.create with the upstream, then gitCredentials.create (update on credential_exists), then wait for the default branch, pulling if it does not come.',
    }
  },
}
