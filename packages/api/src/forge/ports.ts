// The provider operations of the API, written once over `ProviderSync`. Each
// domain gives its own access check and delegates here, so both stores answer
// the same.
import { apiError } from '../problem'
import type { Principal } from '../auth'
import type { Viewer } from '../domain/records'
import type { ProviderSync } from './sync'
import type { ProviderId } from './types'

type Access = (
  owner: string,
  name: string,
  p: Viewer,
  need: 'read' | 'write',
) => Promise<string>

export const needSync = (s: ProviderSync | null | undefined): ProviderSync => {
  if (!s)
    throw apiError(
      'backend_unavailable',
      'Linking git providers is not set up on this server.',
    )
  return s
}

export function forgeOps(
  sync: () => ProviderSync | null | undefined,
  access: Access,
) {
  const need = () => needSync(sync())
  const asProvider = (p: string) => p as ProviderId
  return {
    providerConnections: (p: Principal) => need().listConnections(p),
    providerRepos: (
      p: Principal,
      provider: string,
      body: {
        github_access?: string
        cursor?: string
        q?: string
        forks?: boolean
        archived?: boolean
      },
    ) => need().listRepos(p, asProvider(provider), body),
    providerOauthStart: (
      p: Principal,
      provider: string,
      redirectUri: string,
      returnTo: string | null,
    ) =>
      need().oauthStartPresented(
        p,
        asProvider(provider),
        redirectUri,
        returnTo,
      ),
    providerOauthFinish: (
      p: Principal,
      provider: string,
      body: { code: string; state: string; redirect_uri: string },
    ) => need().oauthFinishPresented(p, asProvider(provider), body),
    providerDisconnect: (p: Principal, provider: string, dry: boolean) =>
      dry ? Promise.resolve() : need().disconnect(p, asProvider(provider)),
    providerAudit: (p: Principal) => need().auditFor(p),
    importBatch: (
      p: Principal,
      body: {
        provider: string
        slugs: Array<string>
        owner?: string
        visibility?: 'public' | 'private'
        github_access?: string
      },
    ) =>
      need().batchPresented(p, {
        ...body,
        provider: asProvider(body.provider),
      }),
    importJob: (p: Principal, id: string) => need().jobPresented(p, id),
    repoProvider: async (owner: string, name: string, p: Viewer) => {
      const full = await access(owner, name, p, 'write')
      return need().linkOf(p, full)
    },
    adoptProvider: async (
      p: Principal,
      owner: string,
      name: string,
      dry: boolean,
    ) => {
      const full = await access(owner, name, p, 'write')
      if (!dry) await need().adopt(p, full)
      return need().linkOf(p, full)
    },
    refreshProvider: async (
      p: Principal,
      owner: string,
      name: string,
      dry: boolean,
    ) => {
      const full = await access(owner, name, p, 'write')
      if (!dry) await need().scheduleItems(full, 0)
      return need().linkOf(p, full)
    },
    remoteList: async (
      owner: string,
      name: string,
      p: Viewer,
      kind: 'pull' | 'issue' | 'release',
    ) => {
      const full = await access(owner, name, p, 'read')
      return need().items.list(full, kind)
    },
    remotePull: async (
      owner: string,
      name: string,
      p: Viewer,
      number: number,
    ) => {
      const full = await access(owner, name, p, 'read')
      return need().items.pull(full, number)
    },
    remoteIssue: async (
      owner: string,
      name: string,
      p: Viewer,
      number: number,
    ) => {
      const full = await access(owner, name, p, 'read')
      return need().items.issue(full, number)
    },
    remoteComments: async (
      owner: string,
      name: string,
      p: Viewer,
      kind: 'pull' | 'issue',
      number: number,
    ) => {
      const full = await access(owner, name, p, 'read')
      return need().items.comments(full, kind, number)
    },
    remotePatch: async (
      owner: string,
      name: string,
      p: Viewer,
      number: number,
    ) => {
      const full = await access(owner, name, p, 'read')
      return need().items.patch(full, number)
    },
  }
}

export type ForgeOps = ReturnType<typeof forgeOps>
