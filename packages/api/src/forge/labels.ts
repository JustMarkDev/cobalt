import type { ProviderId } from './types'

export const hostLabel: Record<ProviderId, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
}

/** GitHub, GitLab, Codeberg; anything else as given. */
export const labelOf = (p: string): string =>
  (hostLabel as Partial<Record<string, string>>)[p] ?? p

export const ACCESS_WARNING = (provider: string, slug: string) =>
  `Access is decided here: anyone who can write to this repository here can push to ${slug} through Cobalt, even if ${provider} would refuse them. ${provider}'s branch protection rules still apply to those pushes.`

export const LFS_WARNING = (provider: string) =>
  `This repository uses Git LFS (.gitattributes has filter=lfs). Code Storage does not carry LFS objects to ${provider}: large files pushed here will not reach it.`
