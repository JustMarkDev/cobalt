import type { OAuthTokens } from './forge/types'
import { apiError } from './problem'
import type { z } from 'zod'
import type { Principal } from './auth'
import type { Github, GithubRepoRef } from './github'
import type * as S from './schemas'

export const needGithub = (github: Github | null | undefined): Github => {
  if (!github)
    throw apiError(
      'backend_unavailable',
      'Signing in with GitHub is not set up on this server.',
      { hint: 'The operator must set GITHUB_APP_CLIENT_ID.' },
    )
  return github
}

export async function deviceStart(
  github: Github | null | undefined,
): Promise<z.infer<typeof S.GithubDevice>> {
  const d = await needGithub(github).deviceStart()
  return {
    object: 'github_device',
    device_code: d.deviceCode,
    user_code: d.userCode,
    verification_uri: d.verificationUri,
    expires_in: d.expiresIn,
    interval: d.interval,
  }
}

export async function devicePoll(
  github: Github | null | undefined,
  p: Principal,
  deviceCode: string,
  keep?: (login: string, tokens: OAuthTokens) => Promise<void>,
): Promise<z.infer<typeof S.GithubDeviceStatus>> {
  const r = await needGithub(github).devicePoll(deviceCode, p.handle)
  if (r.status === 'authorized') await keep?.(r.login, r.tokens)
  const none = { access: null, login: null, expires_in: null }
  switch (r.status) {
    case 'pending':
    case 'slow_down':
      return {
        object: 'github_device_status',
        status: r.status,
        interval: r.interval,
        ...none,
      }
    case 'authorized':
      return {
        object: 'github_device_status',
        status: 'authorized',
        interval: null,
        access: r.access,
        login: r.login,
        expires_in: r.expiresIn,
      }
    default:
      return {
        object: 'github_device_status',
        status: r.status,
        interval: null,
        ...none,
      }
  }
}

export const presentGithubRepo = (
  r: GithubRepoRef,
  linked: string | null,
): z.infer<typeof S.GithubRepo> => ({
  object: 'github_repo',
  slug: r.slug,
  private: r.private,
  default_branch: r.defaultBranch,
  linked,
  size_bytes: r.sizeBytes,
})

export async function oauthStart(
  github: Github | null | undefined,
  p: Principal,
  redirectUri: string,
  returnTo: string | null,
): Promise<z.infer<typeof S.GithubOauth>> {
  const r = await needGithub(github).oauthStart(p.handle, redirectUri, returnTo)
  return { object: 'github_oauth', url: r.url, install_url: r.installUrl }
}

export async function oauthFinish(
  github: Github | null | undefined,
  p: Principal,
  body: { code: string; state: string; redirect_uri: string },
  keep?: (login: string, tokens: OAuthTokens) => Promise<void>,
): Promise<z.infer<typeof S.GithubOauthResult>> {
  const r = await needGithub(github).oauthFinish(
    p.handle,
    body.code,
    body.state,
    body.redirect_uri,
  )
  await keep?.(r.login, r.tokens)
  return {
    object: 'github_oauth_result',
    access: r.access,
    login: r.login,
    expires_in: r.expiresIn,
    return_to: r.returnTo,
  }
}
