import { USER, createRepo, forgejo, head } from './env'
import type { Ctx } from '../lib'
import type { Forgejo } from './env'

/** A Forgejo repository and a Code Storage store synced from it in generic mode. */
export async function pairForgejo(
  ctx: Ctx,
  tag: string,
  password: string,
  o: { username?: string } = {},
) {
  const f = await forgejo()
  const name = ctx.name(tag)
  await createRepo(f, name)
  ctx.onCleanup(`Forgejo ${name}`, async () => {
    await f.api('DELETE', `/repos/${USER}/${name}`)
  })
  const main = await head(f, name)
  if (!main) throw new Error('the new Forgejo repository has no main')
  const t = Date.now()
  await ctx.storeCreate(name, {
    provider: 'forgejo',
    host: f.host,
    owner: USER,
    name,
  })
  const cred = await ctx.pierre.repos.gitCredentials.create({
    repo_name: name,
    username: o.username ?? USER,
    password,
  })
  const synced = await ctx.storeWaitFor(name, 'main', main, 120_000)
  ctx.log.line(
    synced.value
      ? `pair ${name}: first sync ${Date.now() - t} ms after create`
      : `pair ${name}: no first sync in 120 s (${'last' in synced ? synced.last : ''})`,
  )
  return {
    f,
    name,
    main,
    credentialId: cred.id,
    synced: Boolean(synced.value),
    firstSyncMs: Date.now() - t,
  }
}

export type Pair = Awaited<ReturnType<typeof pairForgejo>>
export type { Forgejo }
