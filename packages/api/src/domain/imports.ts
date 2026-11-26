import { apiError } from '../problem'
import { presentMirror } from '../mirror'
import {
  devicePoll,
  deviceStart,
  needGithub,
  oauthFinish,
  oauthStart,
  presentGithubRepo,
} from '../github-port'
import type { MirrorRec } from '../extras'
import type { Principal } from '../auth'
import type { Viewer } from './records'
import type { Prepared, SyncHost } from '../forge/sync'
import type { ProviderId } from '../forge/types'
import { labelOf } from '../forge/sync'
import { aboutPatch } from '../forge/about'
import { forgeOps } from '../forge/ports'
import { DomainIntegrations } from './integrations'

type Host = 'github' | 'gitlab' | 'codeberg' | 'gitea'

export type LinkRec = {
  host: Host
  login: string
  instance: string | null
  linked: number
}

export abstract class DomainImports extends DomainIntegrations {
  readonly links = new Map<string, Array<LinkRec>>()
  linkRev = 0

  private self(handle: string, p: Viewer) {
    if (
      !p ||
      p.handle !== handle ||
      this.accounts.get(handle)?.kind !== 'person'
    )
      throw apiError('not_found', `No account ${handle}.`)
  }

  private presentLink(handle: string, l: LinkRec) {
    return {
      object: 'linked_account' as const,
      account: handle,
      host: l.host,
      login: l.login,
      instance: l.instance,
      verified: false,
      linked_at: new Date(l.linked).toISOString(),
    }
  }

  seedLink(handle: string, l: LinkRec) {
    this.links.set(handle, [...(this.links.get(handle) ?? []), l])
  }

  async handlesOfLogins(host: string, logins: ReadonlyArray<string>) {
    const want = new Set(logins.map((l) => l.toLowerCase()))
    const found: Record<string, string> = {}
    for (const [handle, ls] of this.links)
      for (const l of ls)
        if (l.host === host && want.has(l.login.toLowerCase()))
          found[l.login.toLowerCase()] = handle
    return found
  }

  async listLinks(handle: string, p: Viewer) {
    this.self(handle, p)
    return (this.links.get(handle) ?? []).map((l) =>
      this.presentLink(handle, l),
    )
  }

  async linkAccount(
    handle: string,
    host: Host,
    p: Viewer,
    body: { login: string; instance?: string },
  ) {
    this.self(handle, p)
    if (host === 'gitea' && !body.instance)
      throw apiError('invalid_request', 'A Gitea account needs its address.', {
        errors: [
          {
            pointer: '/body/instance',
            code: 'required',
            message: 'Gitea runs on your own server: say where.',
          },
        ],
      })
    const list = (this.links.get(handle) ?? []).filter((l) => l.host !== host)
    const l: LinkRec = {
      host,
      login: body.login,
      instance: body.instance ?? null,
      linked: this.now(),
    }
    this.links.set(handle, [...list, l])
    this.linkRev++
    return this.presentLink(handle, l)
  }

  async unlinkAccount(handle: string, host: Host, p: Viewer) {
    this.self(handle, p)
    this.links.set(
      handle,
      (this.links.get(handle) ?? []).filter((l) => l.host !== host),
    )
    this.linkRev++
  }

  private readonly forgeOps = forgeOps(
    () => this.svc.providers,
    (owner, name, p, need) => this.repoAccess(owner, name, p, need),
  )
  providerConnections = this.forgeOps.providerConnections
  providerRepos = this.forgeOps.providerRepos
  providerOauthStart = this.forgeOps.providerOauthStart
  providerOauthFinish = this.forgeOps.providerOauthFinish
  providerDisconnect = this.forgeOps.providerDisconnect
  providerAudit = this.forgeOps.providerAudit
  importBatch = this.forgeOps.importBatch
  importJob = this.forgeOps.importJob
  repoProvider = this.forgeOps.repoProvider
  adoptProvider = this.forgeOps.adoptProvider
  refreshProvider = this.forgeOps.refreshProvider
  remoteList = this.forgeOps.remoteList
  remotePull = this.forgeOps.remotePull
  remoteIssue = this.forgeOps.remoteIssue
  remoteComments = this.forgeOps.remoteComments
  remotePatch = this.forgeOps.remotePatch

  protected providersFor(host: Host) {
    const sync = this.svc.providers
    if (host === 'gitea' || !sync?.configured(host))
      throw apiError(
        'invalid_request',
        `Importing from ${host} is not supported here: ${host === 'gitea' ? 'self-hosted servers are not linked yet' : `${host} is not set up on this server`}.`,
      )
    return sync
  }

  async importRepo(
    p: Principal,
    body: {
      host: Host
      slug: string
      owner?: string
      name?: string
      visibility: 'public' | 'private'
      github_access?: string
    },
    dry: boolean,
  ) {
    const sync = this.providersFor(body.host)
    const pr = await sync.prepare(
      p,
      body.host as ProviderId,
      body.slug,
      body.github_access,
    )
    const name = body.name ?? pr.remote.slug.split('/').pop()!
    const held = await sync.heldBy(pr)
    if (held) {
      const [ho, hn] = held.repo.split('/')
      if (
        (body.owner ?? ho).toLowerCase() !== ho.toLowerCase() ||
        name.toLowerCase() !== hn.toLowerCase()
      )
        throw apiError(
          'invalid_state',
          `${pr.remote.slug} is already linked to ${held.repo}.`,
          { hint: 'A provider repository feeds one repository here.' },
        )
      return {
        repo: this.presentRepo(this.repos.get(held.repo)!),
        created: false,
      }
    }
    if (dry)
      return this.createRepo(
        p,
        {
          owner: body.owner,
          name,
          visibility: body.visibility,
          description: pr.remote.description.trim().slice(0, 500),
        },
        dry,
      )
    const made = await this.importPrepared(p, pr, {
      owner: body.owner ?? p.handle,
      name,
      visibility: body.visibility,
    })
    return {
      repo: this.presentRepo(this.repos.get(made.full)!),
      created: made.created,
    }
  }

  async importPrepared(
    p: Principal,
    pr: Prepared,
    o: { owner: string; name: string; visibility: 'public' | 'private' },
  ) {
    const sync = this.svc.providers!
    const made = await this.createRepo(
      p,
      {
        owner: o.owner,
        name: o.name,
        visibility: o.visibility,
        description: pr.remote.description.trim().slice(0, 500),
      },
      false,
    )
    const full = `${made.repo.owner}/${made.repo.name}`
    if (!made.created)
      throw apiError(
        'invalid_state',
        `${full} already exists and is not linked to ${labelOf(pr.provider)}.`,
        { hint: 'Pick another name with `name`.' },
      )
    const link = sync.link(pr)
    try {
      await sync.deps.git?.provision(full, link)
      await sync.linked(p, full, pr)
    } catch (e) {
      await this.deleteRepo(
        made.repo.owner,
        made.repo.name,
        p,
        full,
        false,
      ).catch(() => undefined)
      throw e
    }
    const rec = this.repos.get(full)!
    rec.upstream = { host: pr.provider, slug: pr.remote.slug }
    rec.defaultBranch = pr.remote.defaultBranch
    const x = this.memExtras.for(full)
    x.mirrors.push({
      id: `mir_${this.now().toString(36)}${x.mirrors.length}`
        .padEnd(22, '0')
        .slice(0, 22),
      host: pr.provider,
      slug: pr.remote.slug,
      direction: 'two-way',
      state: 'syncing',
      lastSync: this.now(),
      detail: `The first sync from ${labelOf(pr.provider)} is running.`,
      created: this.now(),
    })
    rec.version++
    return { full, created: true }
  }

  providerHost(): SyncHost {
    return {
      requireAdmin: async (p, full) => {
        const r = this.repos.get(full)
        if (!r || !this.canWrite(r, p))
          throw apiError('not_found', `No repository ${full}.`)
        const owner = this.accounts.get(r.owner)
        const role =
          owner?.kind === 'organization' ? owner.members.get(p.handle) : null
        if (r.owner !== p.handle && role !== 'owner' && role !== 'admin')
          throw apiError('forbidden', `Only an admin of ${full} can do this.`)
      },
      unlink: async (full) => {
        const r = this.repos.get(full)
        if (!r) return
        const x = this.memExtras.for(full)
        const i = x.mirrors.findIndex((m) => m.host === r.upstream?.host)
        if (i >= 0) x.mirrors.splice(i, 1)
        r.upstream = null
        r.version++
      },
      mirror: async (full, state, detail) => {
        const r = this.repos.get(full)
        const m =
          r &&
          this.memExtras
            .for(full)
            .mirrors.find((x) => x.host === r.upstream?.host)
        if (!m) return
        m.state = state
        m.detail = detail
        if (state === 'in-sync') m.lastSync = this.now()
      },
      importOne: (p, pr, o) => this.importPrepared(p, pr, o),
      setLanguages: async (full, languages) => {
        const r = this.repos.get(full)
        if (r) r.languages = languages
      },
      setAbout: async (full, about, was) => {
        const r = this.repos.get(full)
        if (!r) return
        const next = aboutPatch(
          {
            description: r.description,
            license: r.license,
            website: r.website,
          },
          about,
          was,
        )
        if (next) Object.assign(r, next)
      },
      hasCommit: (full, sha) =>
        this.svc.git.commit(full, sha).then(
          () => true,
          () => false,
        ),
    }
  }

  async listImports(p: Viewer) {
    if (!p) throw apiError('unauthenticated', 'Sign in to see your imports.')
    const out = []
    for (const r of this.repos.values()) {
      if (!r.upstream || !this.canWrite(r, p)) continue
      const full = `${r.owner}/${r.name}`
      const m = this.memExtras
        .for(full)
        .mirrors.find(
          (x) => x.host === r.upstream!.host && x.slug === r.upstream!.slug,
        )
      out.push({
        object: 'import' as const,
        repo: full,
        host: r.upstream.host,
        slug: r.upstream.slug,
        state: m?.state ?? ('in-sync' as const),
        created_at: new Date(r.created).toISOString(),
        warnings: (await this.svc.providers?.warningsFor(full)) ?? [],
      })
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  async githubDeviceStart(_p: Principal) {
    return deviceStart(this.svc.github)
  }

  async githubDevicePoll(p: Principal, deviceCode: string) {
    return devicePoll(this.svc.github, p, deviceCode)
  }

  async githubOauthStart(
    p: Principal,
    redirectUri: string,
    returnTo: string | null,
  ) {
    return oauthStart(this.svc.github, p, redirectUri, returnTo)
  }

  async githubOauthFinish(
    p: Principal,
    body: { code: string; state: string; redirect_uri: string },
  ) {
    return oauthFinish(this.svc.github, p, body)
  }

  async githubRepos(p: Principal, access: string) {
    const linked = new Map<string, string>()
    for (const r of this.repos.values())
      if (r.upstream?.host === 'github')
        linked.set(r.upstream.slug.toLowerCase(), `${r.owner}/${r.name}`)
    return (await needGithub(this.svc.github).repos(access, p.handle)).map(
      (r) => presentGithubRepo(r, linked.get(r.slug.toLowerCase()) ?? null),
    )
  }

  async createMirror(
    p: Principal,
    owner: string,
    name: string,
    body: { host: string; slug: string; direction: MirrorRec['direction'] },
    dry: boolean,
  ) {
    const full = await this.repoAccess(owner, name, p, 'write')
    const x = await this.svc.extras.open(full)
    const same = x.mirrors.find(
      (m) => m.host === body.host && m.slug === body.slug,
    )
    if (same)
      return {
        mirror: presentMirror(this.urls.api, full, same),
        created: false,
      }
    const rec: MirrorRec = {
      id: `mir_${this.now().toString(36)}${x.mirrors.length}`
        .padEnd(22, '0')
        .slice(0, 22),
      host: body.host,
      slug: body.slug,
      direction: body.direction,
      state: 'in-sync',
      lastSync: this.now(),
      detail: null,
      created: this.now(),
    }
    if (!dry) x.mirrors.push(rec)
    return { mirror: presentMirror(this.urls.api, full, rec), created: true }
  }

  private async mirrorOf(
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
  ) {
    const full = await this.repoAccess(owner, name, p, 'write')
    const m = (await this.svc.extras.open(full)).mirrors.find(
      (x) => x.id === mirror,
    )
    if (!m) throw apiError('not_found', `No mirror ${mirror}.`)
    return { full, m }
  }

  async syncMirror(
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    dry: boolean,
  ) {
    const { full, m } = await this.mirrorOf(p, owner, name, mirror)
    if (m.paused)
      throw apiError('invalid_state', `${m.host} ${m.slug} is paused.`, {
        hint: 'Resume it first: PATCH the mirror with paused=false.',
      })
    const synced = {
      ...m,
      state: 'in-sync' as const,
      lastSync: this.now(),
      detail: null,
    }
    if (!dry) Object.assign(m, synced)
    return presentMirror(this.urls.api, full, synced)
  }

  async updateMirror(
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    body: { paused?: boolean; direction?: MirrorRec['direction'] },
    dry: boolean,
  ) {
    const { full, m } = await this.mirrorOf(p, owner, name, mirror)
    const next = {
      ...m,
      paused: body.paused ?? m.paused,
      direction: body.direction ?? m.direction,
    }
    if (!dry) Object.assign(m, next)
    return presentMirror(this.urls.api, full, next)
  }

  async deleteMirror(
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    dry: boolean,
  ) {
    const full = await this.repoAccess(owner, name, p, 'write')
    const x = await this.svc.extras.open(full)
    const i = x.mirrors.findIndex((m) => m.id === mirror)
    if (i < 0) throw apiError('not_found', `No mirror ${mirror}.`)
    if (!dry) x.mirrors.splice(i, 1)
  }
}
