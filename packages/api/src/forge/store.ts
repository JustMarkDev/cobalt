import { apiError } from '../problem'
import { randomSource } from '../ids'
import type { ProviderId } from './types'

export type ConnectionRec = {
  id: string
  handle: string
  provider: ProviderId
  instance: string
  externalId: string
  login: string
  token: string | null
  refresh: string | null
  keyId: string | null
  expiresAt: number | null
  scopes: Array<string>
  state: 'ok' | 'needs_reconnect'
  problem: string | null
  refreshLease: number | null
  created: number
  updated: number
}

export type RemoteState =
  | 'syncing'
  | 'linked'
  | 'delayed'
  | 'broken'
  | 'archived'
  | 'gone'

export type RemoteMeta = {
  private: boolean
  archived: boolean
  defaultBranch: string
  description: string
  stars: number
  forks: number
  license: string | null
  website: string | null
}

export type RemoteRec = {
  id: string
  /** The repository lets people without a linked GitHub account write through the app. */
  botWrites?: boolean
  provider: ProviderId
  instance: string
  externalId: string
  fullName: string
  repo: string
  storeId: string
  connectionId: string | null
  by: string
  state: RemoteState
  problem: string | null
  installation: number | null
  webhookId: string | null
  credentialId: string | null
  lfs: boolean
  meta: RemoteMeta
  lastPull: number
  lastSync: number | null
  etags: Record<string, string>
  importedAt: number | null
  at: number
}

export type JobItemState = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export type JobItem = {
  id: string
  jobId: string
  externalId: string
  slug: string
  name: string
  visibility: 'public' | 'private'
  defaultBranch: string
  installation: number | null
  state: JobItemState
  attempts: number
  lease: number
  error: string | null
  repo: string | null
  updated: number
}

export type JobRec = {
  id: string
  handle: string
  owner: string
  provider: ProviderId
  instance: string
  connectionId: string | null
  state: 'running' | 'done' | 'cancelled'
  total: number
  done: number
  failed: number
  created: number
  updated: number
}

export type AuditAction =
  | 'connected'
  | 'reconnected'
  | 'disconnected'
  | 'imported'
  | 'adopted'
  | 'unlinked'
  | 'relinked'
  | 'published'
  | 'needs_reconnect'

export type AuditRec = {
  handle: string
  provider: ProviderId
  action: AuditAction
  repo: string | null
  detail: string | null
  at: number
}

export type ActorRec = {
  provider: ProviderId
  instance: string
  externalId: string
  login: string
  name: string | null
  avatar: string | null
  deleted: boolean
}

export type ItemKind = 'pull' | 'issue' | 'release'

export type ItemRec = {
  id: string
  repo: string
  kind: ItemKind
  number: number
  key: string
  title: string
  body: string
  state: string
  author: (ActorRec & { id: string }) | null
  labels: Array<string>
  url: string
  created: number
  updated: number
  closed: number | null
  merged: number | null
  head: {
    ref: string
    sha: string
    base: string
    fromFork: boolean
    commitsHere: boolean | null
  } | null
  flags: { draft: boolean; prerelease: boolean } | null
  hasPatch: boolean
  comments: number
  removed: { at: number; by: (ActorRec & { id: string }) | null } | null
}

export type ItemWrite = Omit<
  ItemRec,
  'id' | 'repo' | 'author' | 'removed' | 'comments' | 'hasPatch'
> & { authorId: string | null }

export type CommentRec = {
  externalId: string
  body: string
  author: (ActorRec & { id: string }) | null
  created: number
  updated: number
  removed: number | null
}

export interface ProviderStore {
  connection: (
    handle: string,
    provider: ProviderId,
    instance: string,
  ) => Promise<ConnectionRec | null>
  connectionById: (id: string) => Promise<ConnectionRec | null>
  connections: (handle: string) => Promise<Array<ConnectionRec>>
  saveConnection: (
    c: Omit<ConnectionRec, 'id' | 'created' | 'updated' | 'refreshLease'>,
    now: number,
  ) => Promise<ConnectionRec>
  patchConnection: (
    id: string,
    patch: Partial<
      Pick<
        ConnectionRec,
        | 'token'
        | 'refresh'
        | 'keyId'
        | 'expiresAt'
        | 'state'
        | 'problem'
        | 'refreshLease'
        | 'scopes'
      >
    >,
    now: number,
  ) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  leaseRefresh: (
    id: string,
    now: number,
    ms: number,
  ) => Promise<ConnectionRec | null>

  remoteByExternal: (
    provider: ProviderId,
    instance: string,
    externalId: string,
  ) => Promise<RemoteRec | null>
  remoteOfRepo: (repo: string) => Promise<RemoteRec | null>
  claims: (
    provider: ProviderId,
    instance: string,
    ids: Array<string>,
  ) => Promise<Record<string, string>>
  remotesOfConnection: (connectionId: string) => Promise<Array<RemoteRec>>
  remotesOfInstallation: (installation: number) => Promise<Array<RemoteRec>>
  claimRemote: (
    r: Omit<RemoteRec, 'id' | 'storeId' | 'etags' | 'importedAt'>,
  ) => Promise<RemoteRec>
  patchRemote: (
    id: string,
    patch: Partial<
      Pick<
        RemoteRec,
        | 'state'
        | 'problem'
        | 'fullName'
        | 'connectionId'
        | 'by'
        | 'installation'
        | 'webhookId'
        | 'credentialId'
        | 'lfs'
        | 'meta'
        | 'lastPull'
        | 'lastSync'
        | 'etags'
        | 'importedAt'
      >
    >,
  ) => Promise<void>
  dropRemote: (id: string) => Promise<void>
  stale: (before: number, max: number) => Promise<Array<RemoteRec>>

  seen: (
    provider: ProviderId,
    deliveryId: string,
    now: number,
  ) => Promise<boolean>

  createJob: (
    job: Omit<JobRec, 'id' | 'done' | 'failed' | 'state' | 'updated'>,
    items: Array<
      Pick<
        JobItem,
        | 'externalId'
        | 'slug'
        | 'name'
        | 'visibility'
        | 'defaultBranch'
        | 'installation'
      >
    >,
  ) => Promise<string>
  job: (id: string) => Promise<{ job: JobRec; items: Array<JobItem> } | null>
  claimItems: (
    now: number,
    leaseMs: number,
    max: number,
  ) => Promise<Array<{ item: JobItem; job: JobRec }>>
  finishItem: (
    id: string,
    r:
      | {
          state: 'done' | 'skipped'
          repo: string | null
          error?: string | null
        }
      | { state: 'failed'; error: string }
      | { state: 'queued'; error: string; retryAt: number },
    now: number,
  ) => Promise<void>

  itemsDue: (now: number, max: number) => Promise<Array<RemoteRec>>
  setItemsDue: (repo: string, at: number | null) => Promise<void>
  putItem: (repo: string, item: ItemWrite) => Promise<string | null>
  itemsOf: (
    repo: string,
    kind: ItemKind,
    max: number,
  ) => Promise<Array<ItemRec>>
  item: (repo: string, kind: ItemKind, key: string) => Promise<ItemRec | null>
  markRemoved: (
    repo: string,
    kind: ItemKind,
    key: string,
    at: number,
    byId: string | null,
  ) => Promise<void>
  putComments: (
    itemId: string,
    comments: Array<
      Omit<CommentRec, 'author' | 'removed'> & { authorId: string | null }
    >,
    now: number,
  ) => Promise<void>
  commentsOf: (itemId: string) => Promise<Array<CommentRec>>
  putPatch: (itemId: string, text: string) => Promise<void>
  patchOf: (
    itemId: string,
  ) => Promise<{ text: string; truncated: boolean } | null>

  audit: (a: AuditRec) => Promise<void>
  auditOf: (handle: string, max: number) => Promise<Array<AuditRec>>
  upsertActor: (a: ActorRec, now: number) => Promise<string>
}

const nextId = (p: string) =>
  `${p}_${Buffer.from(randomSource.bytes(9))
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')}`

export class MemoryProviderStore implements ProviderStore {
  readonly conns = new Map<string, ConnectionRec>()
  readonly remotes = new Map<string, RemoteRec>()
  readonly jobs = new Map<string, JobRec>()
  readonly items = new Map<string, JobItem>()
  readonly deliveries = new Map<string, number>()
  readonly log: Array<AuditRec> = []
  readonly actors = new Map<string, ActorRec & { id: string }>()

  constructor(private readonly storeOf: (repo: string) => string = (r) => r) {}

  async connection(handle: string, provider: ProviderId, instance: string) {
    for (const c of this.conns.values())
      if (
        c.handle === handle &&
        c.provider === provider &&
        c.instance === instance
      )
        return { ...c }
    return null
  }
  async connectionById(id: string) {
    const c = this.conns.get(id)
    return c ? { ...c } : null
  }
  async connections(handle: string) {
    return [...this.conns.values()]
      .filter((c) => c.handle === handle)
      .map((c) => ({ ...c }))
  }
  async saveConnection(
    c: Omit<ConnectionRec, 'id' | 'created' | 'updated' | 'refreshLease'>,
    now: number,
  ) {
    const had = await this.connection(c.handle, c.provider, c.instance)
    const rec: ConnectionRec = {
      ...c,
      id: had?.id ?? nextId('pcn'),
      created: had?.created ?? now,
      updated: now,
      refreshLease: null,
    }
    this.conns.set(rec.id, rec)
    return { ...rec }
  }
  async patchConnection(
    id: string,
    patch: Partial<ConnectionRec>,
    now: number,
  ) {
    const c = this.conns.get(id)
    if (c) Object.assign(c, patch, { updated: now })
  }
  async deleteConnection(id: string) {
    this.conns.delete(id)
  }
  async leaseRefresh(id: string, now: number, ms: number) {
    const c = this.conns.get(id)
    if (!c || (c.refreshLease !== null && c.refreshLease > now)) return null
    c.refreshLease = now + ms
    return { ...c }
  }

  async remoteByExternal(
    provider: ProviderId,
    instance: string,
    externalId: string,
  ) {
    for (const r of this.remotes.values())
      if (
        r.provider === provider &&
        r.instance === instance &&
        r.externalId === externalId
      )
        return { ...r }
    return null
  }
  async remoteOfRepo(repo: string) {
    for (const r of this.remotes.values())
      if (r.repo.toLowerCase() === repo.toLowerCase()) return { ...r }
    return null
  }
  async claims(provider: ProviderId, instance: string, ids: Array<string>) {
    const out: Record<string, string> = {}
    for (const r of this.remotes.values())
      if (
        r.provider === provider &&
        r.instance === instance &&
        ids.includes(r.externalId)
      )
        out[r.externalId] = r.repo
    return out
  }
  async remotesOfConnection(connectionId: string) {
    return [...this.remotes.values()]
      .filter((r) => r.connectionId === connectionId)
      .map((r) => ({ ...r }))
  }
  async remotesOfInstallation(installation: number) {
    return [...this.remotes.values()]
      .filter((r) => r.installation === installation)
      .map((r) => ({ ...r }))
  }
  async claimRemote(
    r: Omit<RemoteRec, 'id' | 'storeId' | 'etags' | 'importedAt'>,
  ) {
    const held = await this.remoteByExternal(
      r.provider,
      r.instance,
      r.externalId,
    )
    if (held && held.repo.toLowerCase() !== r.repo.toLowerCase())
      throw apiError(
        'invalid_state',
        `${r.fullName} is already linked to ${held.repo}.`,
        { hint: 'A provider repository feeds one repository here.' },
      )
    if (held) return held
    const rec: RemoteRec = {
      ...r,
      id: nextId('rmt'),
      storeId: this.storeOf(r.repo),
      etags: {},
      importedAt: null,
    }
    this.remotes.set(rec.id, rec)
    return { ...rec }
  }
  async patchRemote(id: string, patch: Partial<RemoteRec>) {
    const r = this.remotes.get(id)
    if (r) Object.assign(r, patch)
  }
  async dropRemote(id: string) {
    this.remotes.delete(id)
  }
  async stale(before: number, max: number) {
    return [...this.remotes.values()]
      .filter((r) => r.lastPull < before && r.state !== 'gone')
      .sort((a, b) => a.lastPull - b.lastPull)
      .slice(0, max)
      .map((r) => ({ ...r }))
  }

  async seen(provider: ProviderId, deliveryId: string, now: number) {
    const k = `${provider}:${deliveryId}`
    if (this.deliveries.has(k)) return true
    this.deliveries.set(k, now)
    return false
  }

  async createJob(
    job: Omit<JobRec, 'id' | 'done' | 'failed' | 'state' | 'updated'>,
    items: Parameters<ProviderStore['createJob']>[1],
  ) {
    const id = nextId('imj')
    this.jobs.set(id, {
      ...job,
      id,
      state: items.length ? 'running' : 'done',
      done: 0,
      failed: 0,
      updated: job.created,
    })
    for (const it of items) {
      const iid = nextId('imi')
      this.items.set(iid, {
        ...it,
        id: iid,
        jobId: id,
        state: 'queued',
        attempts: 0,
        lease: 0,
        error: null,
        repo: null,
        updated: job.created,
      })
    }
    return id
  }
  async job(id: string) {
    const job = this.jobs.get(id)
    if (!job) return null
    return {
      job: { ...job },
      items: [...this.items.values()]
        .filter((i) => i.jobId === id)
        .map((i) => ({ ...i })),
    }
  }
  async claimItems(now: number, leaseMs: number, max: number) {
    const out: Array<{ item: JobItem; job: JobRec }> = []
    for (const it of this.items.values()) {
      if (out.length >= max) break
      const job = this.jobs.get(it.jobId)
      if (!job || job.state !== 'running') continue
      const due =
        (it.state === 'queued' && it.lease <= now) ||
        (it.state === 'running' && it.lease <= now)
      if (!due) continue
      it.state = 'running'
      it.lease = now + leaseMs
      it.attempts++
      out.push({ item: { ...it }, job: { ...job } })
    }
    return out
  }
  async finishItem(
    id: string,
    r: Parameters<ProviderStore['finishItem']>[1],
    now: number,
  ) {
    const it = this.items.get(id)
    if (!it) return
    const job = this.jobs.get(it.jobId)!
    it.updated = now
    if (r.state === 'queued') {
      it.state = 'queued'
      it.lease = r.retryAt
      it.error = r.error
      return
    }
    it.state = r.state
    it.error = r.state === 'failed' ? r.error : (r.error ?? null)
    if (r.state !== 'failed') it.repo = r.repo
    if (r.state === 'failed') job.failed++
    else job.done++
    job.updated = now
    if (job.done + job.failed >= job.total) job.state = 'done'
  }

  readonly itemRecs = new Map<
    string,
    ItemWrite & {
      id: string
      repo: string
      removed: { at: number; byId: string | null } | null
    }
  >()
  readonly commentRecs = new Map<
    string,
    Array<Omit<CommentRec, 'author'> & { authorId: string | null }>
  >()
  readonly patches = new Map<string, { text: string; truncated: boolean }>()
  readonly due = new Map<string, number>()

  private actorById(id: string | null) {
    if (!id) return null
    for (const a of this.actors.values()) if (a.id === id) return { ...a }
    return null
  }

  private present(
    i: ItemWrite & {
      id: string
      repo: string
      removed: { at: number; byId: string | null } | null
    },
  ): ItemRec {
    const { authorId, removed, ...rest } = i
    return {
      ...rest,
      author: this.actorById(authorId),
      removed: removed
        ? { at: removed.at, by: this.actorById(removed.byId) }
        : null,
      comments: (this.commentRecs.get(i.id) ?? []).filter(
        (c) => c.removed === null,
      ).length,
      hasPatch: this.patches.has(i.id),
    }
  }

  private itemKey(repo: string, kind: ItemKind, key: string) {
    return `${repo.toLowerCase()}|${kind}|${key}`
  }

  async itemsDue(now: number, max: number) {
    const out: Array<RemoteRec> = []
    for (const r of this.remotes.values()) {
      const at = this.due.get(r.repo.toLowerCase())
      if (at !== undefined && at <= now && r.state !== 'gone')
        out.push({ ...r })
    }
    return out.slice(0, max)
  }
  async setItemsDue(repo: string, at: number | null) {
    if (at === null) this.due.delete(repo.toLowerCase())
    else this.due.set(repo.toLowerCase(), at)
  }
  async putItem(repo: string, item: ItemWrite) {
    const k = this.itemKey(repo, item.kind, item.key)
    const had = this.itemRecs.get(k)
    if (had) {
      const { id: _id, repo: _repo, removed, ...was } = had
      void _id
      void _repo
      if (JSON.stringify(was) === JSON.stringify(item) && !removed) return null
      this.itemRecs.set(k, { ...item, id: had.id, repo, removed: null })
      return had.id
    }
    const id = nextId('rit')
    this.itemRecs.set(k, { ...item, id, repo, removed: null })
    return id
  }
  async itemsOf(repo: string, kind: ItemKind, max: number) {
    return [...this.itemRecs.values()]
      .filter(
        (i) => i.repo.toLowerCase() === repo.toLowerCase() && i.kind === kind,
      )
      .sort((a, b) => b.updated - a.updated)
      .slice(0, max)
      .map((i) => this.present(i))
  }
  async item(repo: string, kind: ItemKind, key: string) {
    const i = this.itemRecs.get(this.itemKey(repo, kind, key))
    return i ? this.present(i) : null
  }
  async markRemoved(
    repo: string,
    kind: ItemKind,
    key: string,
    at: number,
    byId: string | null,
  ) {
    const i = this.itemRecs.get(this.itemKey(repo, kind, key))
    if (i && !i.removed) i.removed = { at, byId }
  }
  async putComments(
    itemId: string,
    comments: Array<
      Omit<CommentRec, 'author' | 'removed'> & { authorId: string | null }
    >,
    now: number,
  ) {
    const had = this.commentRecs.get(itemId) ?? []
    const seen = new Set(comments.map((c) => c.externalId))
    const kept = had
      .filter((c) => !seen.has(c.externalId))
      .map((c) => ({ ...c, removed: c.removed ?? now }))
    this.commentRecs.set(itemId, [
      ...comments.map((c) => ({ ...c, removed: null })),
      ...kept,
    ])
  }
  async commentsOf(itemId: string) {
    return (this.commentRecs.get(itemId) ?? [])
      .map(({ authorId, ...c }) => ({ ...c, author: this.actorById(authorId) }))
      .sort((a, b) => a.created - b.created)
  }
  async putPatch(itemId: string, text: string) {
    const max = 900 * 1024
    this.patches.set(itemId, {
      text: text.slice(0, max),
      truncated: text.length > max,
    })
  }
  async patchOf(itemId: string) {
    return this.patches.get(itemId) ?? null
  }

  async audit(a: AuditRec) {
    this.log.push({ ...a })
  }
  async auditOf(handle: string, max: number) {
    return this.log
      .filter((a) => a.handle === handle)
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
  }
  async upsertActor(a: ActorRec) {
    const k = `${a.provider}:${a.instance}:${a.externalId}`
    const had = this.actors.get(k)
    const id = had?.id ?? nextId('xac')
    this.actors.set(k, { ...a, id })
    return id
  }
}
