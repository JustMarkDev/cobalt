import { run } from '../domain/convex'
import type { ConvexCall } from '../domain/convex'
import type {
  ActorRec,
  AuditRec,
  CommentRec,
  ConnectionRec,
  ItemKind,
  ItemRec,
  ItemWrite,
  JobItem,
  JobRec,
  ProviderStore,
  RemoteRec,
} from './store'
import type { ProviderId } from './types'

export class ConvexProviderStore implements ProviderStore {
  constructor(private readonly call: ConvexCall) {}

  private q<T>(name: string, args: Record<string, unknown>) {
    return run<T>(this.call, 'query', `forge/providers:${name}`, args, 'system')
  }
  private m<T>(name: string, args: Record<string, unknown>) {
    return run<T>(
      this.call,
      'mutation',
      `forge/providers:${name}`,
      args,
      'system',
    )
  }

  connection = (handle: string, provider: ProviderId, instance: string) =>
    this.q<ConnectionRec | null>('connection', { handle, provider, instance })
  connectionById = (id: string) =>
    this.q<ConnectionRec | null>('connectionById', { id })
  connections = (handle: string) =>
    this.q<Array<ConnectionRec>>('connections', { handle })
  saveConnection: ProviderStore['saveConnection'] = (c, now) =>
    this.m('saveConnection', { c, now })
  patchConnection: ProviderStore['patchConnection'] = async (
    id,
    patch,
    now,
  ) => {
    await this.m('patchConnection', { id, patch, now })
  }
  deleteConnection = async (id: string) => {
    await this.m('deleteConnection', { id })
  }
  leaseRefresh = (id: string, now: number, ms: number) =>
    this.m<ConnectionRec | null>('leaseRefresh', { id, now, ms })

  remoteByExternal = (
    provider: ProviderId,
    instance: string,
    externalId: string,
  ) =>
    this.q<RemoteRec | null>('remoteByExternal', {
      provider,
      instance,
      externalId,
    })
  remoteOfRepo = (repo: string) =>
    this.q<RemoteRec | null>('remoteOfRepo', { repo })
  claims = (provider: ProviderId, instance: string, ids: Array<string>) =>
    this.q<Record<string, string>>('claims', { provider, instance, ids })
  remotesOfConnection = (connectionId: string) =>
    this.q<Array<RemoteRec>>('remotesOfConnection', { connectionId })
  remotesOfInstallation = (installation: number) =>
    this.q<Array<RemoteRec>>('remotesOfInstallation', { installation })
  claimRemote: ProviderStore['claimRemote'] = (r) =>
    this.m('claimRemote', { r })
  patchRemote: ProviderStore['patchRemote'] = async (id, patch) => {
    await this.m('patchRemote', { id, patch })
  }
  dropRemote = async (id: string) => {
    await this.m('dropRemote', { id })
  }
  stale = (before: number, max: number) =>
    this.q<Array<RemoteRec>>('stale', { before, max })

  seen = (provider: ProviderId, deliveryId: string, now: number) =>
    this.m<boolean>('seen', { provider, deliveryId, now })

  createJob: ProviderStore['createJob'] = (job, items) =>
    this.m('createJob', { job, items })
  job = (id: string) =>
    this.q<{ job: JobRec; items: Array<JobItem> } | null>('job', { id })
  claimItems = (now: number, leaseMs: number, max: number) =>
    this.m<Array<{ item: JobItem; job: JobRec }>>('claimItems', {
      now,
      leaseMs,
      max,
    })
  finishItem: ProviderStore['finishItem'] = async (id, r, now) => {
    await this.m('finishItem', {
      id,
      state: r.state,
      repo: 'repo' in r ? r.repo : null,
      error:
        r.state === 'done' || r.state === 'skipped'
          ? (r.error ?? null)
          : r.error,
      retryAt: r.state === 'queued' ? r.retryAt : 0,
      now,
    })
  }

  itemsDue = (now: number, max: number) =>
    this.q<Array<RemoteRec>>('itemsDue', { now, max })
  setItemsDue = async (repo: string, at: number | null) => {
    await this.m('setItemsDue', { repo, at })
  }
  putItem = (repo: string, item: ItemWrite) =>
    this.m<string | null>('putItem', { repo, item })
  itemsOf = (repo: string, kind: ItemKind, max: number) =>
    this.q<Array<ItemRec>>('itemsOf', { repo, kind, max })
  item = (repo: string, kind: ItemKind, key: string) =>
    this.q<ItemRec | null>('item', { repo, kind, key })
  markRemoved = async (
    repo: string,
    kind: ItemKind,
    key: string,
    at: number,
    byId: string | null,
  ) => {
    await this.m('markRemoved', { repo, kind, key, at, byId })
  }
  putComments: ProviderStore['putComments'] = async (itemId, comments, now) => {
    await this.m('putComments', { itemId, comments, now })
  }
  commentsOf = (itemId: string) =>
    this.q<Array<CommentRec>>('commentsOf', { itemId })
  putPatch = async (itemId: string, text: string) => {
    await this.m('putPatch', { itemId, text })
  }
  patchOf = (itemId: string) =>
    this.q<{ text: string; truncated: boolean } | null>('patchOf', { itemId })

  audit = async (a: AuditRec) => {
    await this.m('audit', { a })
  }
  auditOf = (handle: string, max: number) =>
    this.q<Array<AuditRec>>('auditOf', { handle, max })
  upsertActor = (a: ActorRec, now: number) =>
    this.m<string>('upsertActor', { a, now })

  claimSweeps = (now: number, max: number) =>
    this.m<Array<{ id: string; key: string }>>('claimSweeps', { now, max })
  sweepDeliveries = async (before: number) => {
    await this.m('sweepDeliveries', { before })
  }
  doneSweeps = async (ids: Array<string>) => {
    await this.m('doneSweeps', { ids })
  }
  setLanguages = async (repo: string, languages: Array<[string, number]>) => {
    await this.m('setLanguages', { repo, languages })
  }
}
