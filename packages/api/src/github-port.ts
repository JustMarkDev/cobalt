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
): Promise<z.infer<typeof S.GithubDeviceStatus>> {
  const r = await needGithub(github).devicePoll(deviceCode, p.handle)
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
})
