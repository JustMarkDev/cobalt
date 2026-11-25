import { pierreFromEnv } from './pierre'
import type { Pierre } from '@pierre/sdk'

export type UpstreamProvider = 'github' | 'gitlab' | 'codeberg' | 'forgejo'

export type Upstream = {
  provider: UpstreamProvider
  host?: string
  owner: string
  name: string
}

export type GitCredential = { username: string; password: string }

export type ProvisionOptions =
  | { upstream?: undefined; defaultBranch?: string }
  | { upstream: Upstream; defaultBranch: string }

export interface GitStores {
  provision: (storeId: string, opts?: ProvisionOptions) => Promise<void>
  pull: (storeId: string) => Promise<void>
  detach: (storeId: string) => Promise<void>
  relink: (
    storeId: string,
    upstream: Upstream,
    defaultBranch: string,
  ) => Promise<void>
  setCredential: (storeId: string, cred: GitCredential) => Promise<string>
  updateCredential: (
    storeId: string,
    credentialId: string,
    cred: GitCredential,
  ) => Promise<void>
  deleteCredential: (storeId: string, credentialId: string) => Promise<void>
}

const wire = (u: Upstream) => ({
  provider: u.provider,
  owner: u.owner,
  name: u.name,
  ...(u.host ? { host: u.host } : {}),
})

export class CredentialExists extends Error {
  constructor(readonly storeId: string) {
    super(`${storeId} already has a git credential.`)
    this.name = 'CredentialExists'
  }
}

export function codeStorageStores(
  pierre: () => Pierre = () => pierreFromEnv(),
): GitStores {
  return {
    async provision(storeId, opts) {
      await pierre().repos.create({
        repo_name: storeId,
        ...(opts?.defaultBranch ? { default_branch: opts.defaultBranch } : {}),
        ...(opts?.upstream ? { upstream: wire(opts.upstream) } : {}),
      })
    },
    async pull(storeId) {
      await pierre().repos.upstream.pull({ repo_name: storeId })
    },
    async detach(storeId) {
      await pierre().repos.upstream.delete({ repo_name: storeId })
    },
    async relink(storeId, upstream, defaultBranch) {
      try {
        await pierre().repos.upstream.delete({ repo_name: storeId })
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e
      }
      await pierre().repos.create({
        repo_name: storeId,
        default_branch: defaultBranch,
        upstream: wire(upstream),
      })
    },
    async setCredential(storeId, cred) {
      try {
        const made = await pierre().repos.gitCredentials.create({
          repo_name: storeId,
          username: cred.username,
          password: cred.password,
        })
        return made.id
      } catch (e) {
        if ((e as { code?: string }).code === 'credential_exists')
          throw new CredentialExists(storeId)
        throw e
      }
    },
    async updateCredential(storeId, credentialId, cred) {
      await pierre().repos.gitCredentials.update({
        repo_name: storeId,
        git_credential_id: credentialId,
        username: cred.username,
        password: cred.password,
      })
    },
    async deleteCredential(storeId, credentialId) {
      try {
        await pierre().repos.gitCredentials.delete({
          repo_name: storeId,
          git_credential_id: credentialId,
        })
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e
      }
    },
  }
}
