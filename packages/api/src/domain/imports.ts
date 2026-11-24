import { apiError } from '../problem'
import { presentMirror } from '../mirror'
import {
  devicePoll,
  deviceStart,
  needGithub,
  presentGithubRepo,
} from '../github-port'
import type { MirrorRec } from '../extras'
import type { Principal } from '../auth'
import type { Viewer } from './records'
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
    if (body.host !== 'github')
      throw apiError(
        'invalid_request',
        `Importing from ${body.host} is not supported: only GitHub repositories can be linked.`,
      )
    if (this.svc.github) {
      if (!body.github_access)
        throw apiError(
          'invalid_request',
          'Importing from GitHub needs `github_access`.',
          {
            hint: 'Sign in with GitHub first: POST /github/device.',
          },
        )
      await this.svc.github.authorize(body.github_access, p.handle, body.slug)
    }
    const name = body.name ?? body.slug.split('/').pop()!
    for (const r of this.repos.values())
      if (
        r.upstream?.host === body.host &&
        r.upstream.slug.toLowerCase() === body.slug.toLowerCase()
      ) {
        const held = `${r.owner}/${r.name}`
        if (
          (body.owner ?? r.owner).toLowerCase() !== r.owner.toLowerCase() ||
          name.toLowerCase() !== r.name.toLowerCase()
        )
          throw apiError(
            'invalid_state',
            `${body.slug} is already linked to ${held}.`,
            { hint: 'A GitHub repository feeds one repository here.' },
          )
      }
    const made = await this.createRepo(
      p,
      {
        owner: body.owner,
        name,
        visibility: body.visibility,
        description: `Imported from ${body.host}:${body.slug}`,
      },
      dry,
    )
    if (dry) return made
    const full = `${made.repo.owner}/${made.repo.name}`
    const rec = this.repos.get(full)!
    if (made.created || !rec.upstream) {
      rec.upstream = { host: body.host, slug: body.slug }
      const x = this.memExtras.for(full)
      if (!x.mirrors.some((m) => m.host === body.host && m.slug === body.slug))
        x.mirrors.push({
          id: `mir_${this.now().toString(36)}${x.mirrors.length}`
            .padEnd(22, '0')
            .slice(0, 22),
          host: body.host,
          slug: body.slug,
          direction: 'two-way',
          state: 'syncing',
          lastSync: this.now(),
          detail: 'The first sync from GitHub is running.',
          created: this.now(),
        })
      rec.version++
    }
    return { repo: this.presentRepo(rec), created: made.created }
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
