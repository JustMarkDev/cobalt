// Forgejo 4. Tokens as git passwords: a PAT and an OAuth access token; what
// happens when the OAuth token expires; refreshing it and updating the stored
// credential with gitCredentials.update while a sync runs; refresh-token reuse.
import { clean, commitFile, errorOf, until } from '../lib'
import { pairForgejo } from './common'
import {
  ACCESS_TOKEN_TTL,
  LOCAL,
  USER,
  commit,
  forgejo,
  head,
  pat,
} from './env'
import { authorize, oauthApp, refresh } from './oauth'
import type { Scenario } from '../lib'

/** Can git read a Forgejo repository with this username and password? */
async function gitReads(repo: string, username: string, password: string) {
  const r = await fetch(
    `${LOCAL}/${USER}/${repo}.git/info/refs?service=git-upload-pack`,
    {
      headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` },
    },
  )
  return r.status
}

export const forgejoTokens: Scenario = {
  id: 'forgejo-04-tokens',
  title:
    'Generic mode: PAT and OAuth token as git password, expiry, refresh, credential update',
  async run(ctx) {
    const f = await forgejo()
    const app = await oauthApp(f)
    const first = await authorize(app)
    if (!first.ok) throw new Error(`OAuth flow: ${first.error}`)
    const issued = Date.now()
    ctx.log.line(
      `OAuth flow done; access token lives ${first.tokens.expires_in} s`,
    )

    const p = await pairForgejo(ctx, 'fj-oauth', first.tokens.access_token)
    const patStatus = await gitReads(p.name, USER, await pat(f))
    const ownNameStatus = await gitReads(
      p.name,
      USER,
      first.tokens.access_token,
    )
    const fixedNameStatus = await gitReads(
      p.name,
      'oauth2',
      first.tokens.access_token,
    )
    ctx.log.line(
      `git info/refs: PAT ${patStatus}; OAuth token with username ${USER} ${ownNameStatus}, with "oauth2" ${fixedNameStatus}`,
    )
    ctx.log.line(`store synced with the OAuth token as password: ${p.synced}`)

    // Wait past expiry, then try both directions.
    const wait = issued + (ACCESS_TOKEN_TTL + 15) * 1000 - Date.now()
    ctx.log.line(
      `waiting ${Math.round(wait / 1000)} s for the access token to expire`,
    )
    await Bun.sleep(Math.max(0, wait))
    const expiredStatus = await gitReads(
      p.name,
      USER,
      first.tokens.access_token,
    )
    const theirs = await commit(f, p.name, 'after-expiry.txt', 'x\n')
    let pullAnswer: string
    try {
      pullAnswer = `ok: ${(await ctx.storePullSettled(p.name)).message}`
    } catch (e) {
      pullAnswer = errorOf(e).split(' body=')[0]
    }
    const arrived = await ctx.storeWaitFor(p.name, 'main', theirs, 20_000)
    const repo = await ctx.pierre.repos.get({ repo_name: p.name })
    ctx.log.line(
      `expired: git info/refs ${expiredStatus}; upstream.pull ${pullAnswer}; commit arrived ${Boolean(arrived.value)}; repos.get ${JSON.stringify(repo.upstream)}`,
    )
    const dir = await ctx.cloneStore(p.name)
    commitFile(dir, 'ours.txt', 'y\n')
    const pushExpired = await ctx.gitStore(p.name, dir, [
      'push',
      'origin',
      'HEAD:main',
    ])
    ctx.log.line(
      `push with the expired credential exit ${pushExpired.code}:\n${clean(pushExpired.out)}`,
    )

    // Refresh, then update the credential right after a pull starts.
    const next = await refresh(app, first.tokens.refresh_token)
    if (!next.ok) throw new Error(`refresh: ${next.error}`)
    const reuse = await refresh(app, first.tokens.refresh_token)
    ctx.log.line(
      `refresh ok; reusing the old refresh token: ${reuse.ok ? 'accepted' : reuse.error}`,
    )
    let midPull = ''
    try {
      midPull = `ok: ${(await ctx.storePull(p.name)).message}`
    } catch (e) {
      midPull = errorOf(e).split(' body=')[0]
    }
    let update: string
    try {
      await ctx.pierre.repos.gitCredentials.update({
        repo_name: p.name,
        git_credential_id: p.credentialId,
        username: USER,
        password: next.tokens.access_token,
      })
      update = 'ok'
    } catch (e) {
      update = errorOf(e).split(' body=')[0]
    }
    ctx.log.line(
      `pull started (${midPull}), then gitCredentials.update: ${update}`,
    )
    await ctx.storePullSettled(p.name).catch(() => undefined)
    const healed = await ctx.storeWaitFor(p.name, 'main', theirs, 60_000)
    ctx.log.line(
      `after the update and a pull, the Forgejo commit arrived: ${Boolean(healed.value)} (${healed.ms} ms)`,
    )
    await ctx.gitStore(p.name, dir, [
      'pull',
      '--quiet',
      '--rebase',
      'origin',
      'main',
    ])
    const ours = commitFile(dir, 'ours2.txt', 'z\n')
    const pushAfter = await ctx.gitStore(p.name, dir, [
      'push',
      'origin',
      'HEAD:main',
    ])
    const pushed =
      pushAfter.ok &&
      Boolean(
        (
          await until(async () => (await head(f, p.name)) === ours, {
            timeout: 30_000,
          })
        ).value,
      )
    ctx.log.line(
      `push after the update exit ${pushAfter.code}, on Forgejo ${pushed}`,
    )

    const gitAccessWorks = p.synced && ownNameStatus === 200
    return {
      outcome: gitAccessWorks && healed.value && pushed ? 'pass' : 'finding',
      summary: `OAuth access token as git password: ${gitAccessWorks ? 'works' : 'does not work'} (info/refs ${ownNameStatus}; with username "oauth2" ${fixedNameStatus}; PAT ${patStatus}). After expiry: info/refs ${expiredStatus}, upstream.pull answers "${pullAnswer}" and nothing arrives (${arrived.value ? 'wrong: it arrived' : 'silently'}), a push fails: ${clean(
        pushExpired.out,
      )
        .split('\n')
        .filter((l) => /^remote:|^fatal:|^\s*!|^error:/.test(l))
        .join(
          ' | ',
        )}. Refresh then gitCredentials.update during a pull: ${update}; sync ${healed.value ? 'resumes' : 'does not resume'}, push ${pushed ? 'works' : 'fails'}. Reusing a spent refresh token: ${reuse.ok ? 'accepted (no rotation enforced)' : reuse.error}.`,
      consequence:
        'Plan holds for Forgejo/Codeberg: the OAuth token is the git password. An expired credential fails silently on pull (upstream.pull still says ok), so Cobalt must refresh before every pull and forwarded push, keyed on the stored expiry, not on errors. Refresh must be serialized and the new refresh token stored at once.',
      risk: 'OAuth token as git password',
    }
  },
}
