import { apiError } from '../problem'
import { remotePullState, remotePullTarget } from '../lifecycles'
import { ProviderError } from './types'
import type { ChangeState } from '../lifecycles'
import type { ProviderSync } from './sync'
import type {
  ActorRec,
  CommentRec,
  ItemKind,
  ItemRec,
  ProviderStore,
  RemoteRec,
} from './store'
import type {
  ExternalActor,
  ForgeProvider,
  IssueClosedAs,
  ProviderAuth,
  ProviderId,
  RemoteAsset,
  RemoteCheck,
  RemoteComment,
  RemoteIssue,
  RemoteLabel,
  WebhookEvent,
} from './types'

const FIRST_PAGES = 30
const BACKOFF_MS = 15 * 60_000
/**
 * How often a linked repository's items are read again with no webhook
 * asking: a missed delivery costs at most this long. Unchanged lists answer
 * 304, which the providers do not count against the rate limit.
 */
export const ITEMS_EVERY_MS = 30 * 60_000
/** While the first git sync runs, how soon to look again whether it settled. */
const SETTLE_RETRY_MS = 60_000
/**
 * What a read copies. A link read by an older version is read in full once
 * more, so what was added since (labels, reviews, release files) arrives.
 */
const FORMAT = '2'

const iso = (t: number) => new Date(t).toISOString()

export function presentActor(a: (ActorRec & { id: string }) | null) {
  if (!a) return null
  return {
    object: 'external_actor' as const,
    provider: a.provider,
    login: a.login,
    name: a.name,
    avatar_url: a.avatar,
    url: `https://${a.instance}/${a.login}`,
    deleted: a.deleted,
  }
}

const removedOf = (i: ItemRec) =>
  i.removed ? { at: iso(i.removed.at), by: presentActor(i.removed.by) } : null

export function presentPull(provider: ProviderId, i: ItemRec) {
  return {
    object: 'remote_pull' as const,
    provider,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state as ChangeState,
    author: presentActor(i.author),
    head_ref: i.head?.ref ?? '',
    head_sha: i.head?.sha ?? '',
    base_ref: i.head?.base ?? '',
    from_fork: i.head?.fromFork ?? false,
    commits_here: i.head?.commitsHere ?? null,
    has_patch: i.hasPatch,
    comments: i.comments,
    url: i.url,
    created_at: iso(i.created),
    updated_at: iso(i.updated),
    closed_at: i.closed === null ? null : iso(i.closed),
    landed_at: i.merged === null ? null : iso(i.merged),
    removed: removedOf(i),
  }
}

export function presentIssue(provider: ProviderId, i: ItemRec) {
  return {
    object: 'remote_issue' as const,
    provider,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state as 'open' | 'closed',
    author: presentActor(i.author),
    labels: i.labels,
    comments: i.comments,
    url: i.url,
    created_at: iso(i.created),
    updated_at: iso(i.updated),
    closed_at: i.closed === null ? null : iso(i.closed),
    removed: removedOf(i),
  }
}

export function presentRelease(provider: ProviderId, i: ItemRec) {
  return {
    object: 'remote_release' as const,
    provider,
    tag: i.labels[0] ?? i.key,
    name: i.title,
    body: i.body,
    draft: i.flags?.draft ?? false,
    prerelease: i.flags?.prerelease ?? false,
    author: presentActor(i.author),
    url: i.url,
    created_at: iso(i.created),
    published_at: i.closed === null ? null : iso(i.closed),
    removed: removedOf(i),
  }
}

export function presentComment(c: CommentRec) {
  return {
    object: 'remote_comment' as const,
    author: presentActor(c.author),
    body: c.body,
    created_at: iso(c.created),
    updated_at: iso(c.updated),
    removed: c.removed === null ? null : { at: iso(c.removed), by: null },
  }
}

const who = (a: ExternalActor | null) =>
  a ? { id: a.id, login: a.login } : null

type Who = ReturnType<typeof who>

export type Materialize = (
  full: string,
  item:
    | {
        kind: 'pull'
        host: ProviderId
        number: number
        title: string
        description: string
        state: ChangeState
        author: Who
        base: string
        branch: string
        headSha: string
        created: number
        updated: number
        landed: number | null
        files: Record<string, { add: number; del: number }> | null
        comments: Array<{
          id: string
          author: Who
          body: string
          created: number
        }>
        labels?: Array<string>
        reviews?: Array<{
          id: string
          author: Who
          state: 'approved' | 'changes' | 'commented'
          body: string
          sha: string | null
          created: number
        }>
        lineComments?: Array<{
          id: string
          author: Who
          body: string
          path: string
          line: number | null
          replyTo: string | null
          created: number
          updated: number
        }>
      }
    | {
        kind: 'issue'
        host: ProviderId
        number: number
        title: string
        body: string
        state: 'open' | 'closed'
        author: Who
        labels: Array<string>
        closedAs?: IssueClosedAs | null
        assignees?: Array<NonNullable<Who>>
        created: number
        updated: number
        closed: number | null
        comments: Array<{
          id: string
          author: Who
          body: string
          created: number
          updated: number
        }>
      }
    | {
        kind: 'checks'
        host: ProviderId
        number: number
        checks: Array<RemoteCheck>
      }
    | {
        kind: 'secrets'
        host: ProviderId
        names: Array<{ name: string; environment: string | null }>
      }
    | {
        kind: 'release'
        host: ProviderId
        externalId: string
        tag: string
        title: string
        body: string
        prerelease: boolean
        author: Who
        published: number
        assets?: Array<RemoteAsset>
      }
    | {
        kind: 'labels'
        host: ProviderId
        labels: Array<RemoteLabel>
      },
) => Promise<string>

export class RemoteItems {
  constructor(
    private readonly sync: ProviderSync,
    private readonly hasCommit: (full: string, sha: string) => Promise<boolean>,
    private readonly materialize?: Materialize,
  ) {}

  private get store(): ProviderStore {
    return this.sync.store
  }

  private async linkOf(full: string) {
    const r = await this.store.remoteOfRepo(full)
    if (!r) throw apiError('not_found', `${full} is not linked to a provider.`)
    return r
  }

  async list(full: string, kind: ItemKind) {
    const r = await this.linkOf(full)
    const items = await this.store.itemsOf(full, kind, 200)
    const data =
      kind === 'pull'
        ? items.map((i) => presentPull(r.provider, i))
        : kind === 'issue'
          ? items.map((i) => presentIssue(r.provider, i))
          : items.map((i) => presentRelease(r.provider, i))
    return {
      object: 'list' as const,
      data,
      has_more: false as const,
      next_cursor: null,
    }
  }

  private async one(full: string, kind: 'pull' | 'issue', number: number) {
    const i = await this.store.item(full, kind, String(number))
    if (!i)
      throw apiError(
        'not_found',
        `No ${kind === 'pull' ? 'pull request' : 'issue'} #${number} from the provider in ${full}.`,
      )
    return i
  }

  async pull(full: string, number: number) {
    const r = await this.linkOf(full)
    return presentPull(r.provider, await this.one(full, 'pull', number))
  }

  async issue(full: string, number: number) {
    const r = await this.linkOf(full)
    return presentIssue(r.provider, await this.one(full, 'issue', number))
  }

  async comments(full: string, kind: 'pull' | 'issue', number: number) {
    await this.linkOf(full)
    const i = await this.one(full, kind, number)
    return {
      object: 'list' as const,
      data: (await this.store.commentsOf(i.id)).map(presentComment),
      has_more: false as const,
      next_cursor: null,
    }
  }

  async patch(full: string, number: number) {
    await this.linkOf(full)
    const i = await this.one(full, 'pull', number)
    const p = await this.store.patchOf(i.id)
    if (!p)
      throw apiError(
        'not_found',
        `Pull request #${number} has no patch kept here: its commits are in ${full}.`,
      )
    return {
      object: 'remote_patch' as const,
      number,
      text: p.text,
      truncated: p.truncated,
    }
  }

  private async actor(
    r: RemoteRec,
    a: ExternalActor | null,
  ): Promise<string | null> {
    if (!a) return null
    return this.store.upsertActor(
      {
        provider: r.provider,
        instance: r.instance,
        externalId: a.id,
        login: a.login,
        name: a.name,
        avatar: a.avatar,
        deleted: false,
      },
      this.sync.now(),
    )
  }

  private async comments_(
    r: RemoteRec,
    itemId: string,
    list: Array<RemoteComment>,
  ) {
    const out = []
    for (const c of list)
      out.push({
        externalId: c.id,
        body: c.body,
        authorId: await this.actor(r, c.author),
        created: c.created,
        updated: c.updated,
      })
    await this.store.putComments(itemId, out, this.sync.now())
  }

  async syncRepo(r: RemoteRec, o: { full?: boolean } = {}) {
    const forge = this.sync.forge(r.provider)
    const auth = await this.sync.authOf(r).catch(() => null)
    if (!auth) {
      await this.store.setItemsDue(r.repo, null)
      return 0
    }
    const full = o.full ?? (r.importedAt === null || r.etags._format !== FORMAT)
    const since = full ? 0 : (r.importedAt ?? 0) - 5 * 60_000
    const etags = { ...r.etags }
    let changed = 0
    try {
      // Labels first, so issues and changes find them with their colors.
      if (full && forge.listLabels && this.materialize) {
        const labels = await forge
          .listLabels(auth, r.fullName)
          .catch(() => null)
        if (labels)
          await this.materialize(r.repo, {
            kind: 'labels',
            host: r.provider,
            labels,
          })
      }
      changed += await this.pulls(r, forge, auth, { full, since, etags })
      changed += await this.issues(r, forge, auth, { full, since, etags })
      changed += await this.releases(r, forge, auth, { full, etags })
      await this.checks(r, forge, auth)
      if (full && forge.secretNames && this.materialize) {
        const names = await forge
          .secretNames(auth, r.fullName)
          .catch(() => null)
        if (names?.length)
          await this.materialize(r.repo, {
            kind: 'secrets',
            host: r.provider,
            names,
          })
      }
    } catch (e) {
      if (
        e instanceof ProviderError &&
        (e.status === 403 || e.status === 429)
      ) {
        await this.store.setItemsDue(r.repo, this.sync.now() + BACKOFF_MS)
        await this.store.patchRemote(r.id, { etags })
        return changed
      }
      throw e
    }
    const settled =
      r.state === 'syncing' &&
      (await this.hasCommit(r.repo, r.meta.defaultBranch).catch(() => false))
    await this.store.patchRemote(r.id, {
      etags: { ...etags, _format: FORMAT },
      importedAt: this.sync.now(),
      ...(settled
        ? {
            state:
              r.provider === 'github' || r.webhookId
                ? ('linked' as const)
                : ('delayed' as const),
          }
        : {}),
    })
    // A first sync still running is looked at again soon, not left showing
    // "syncing" until a push happens to arrive.
    const waiting = r.state === 'syncing' && !settled
    await this.store.setItemsDue(
      r.repo,
      this.sync.now() + (waiting ? SETTLE_RETRY_MS : ITEMS_EVERY_MS),
    )
    if (settled || r.state === 'linked')
      await this.sync.host?.mirror(r.repo, 'in-sync', null)
    return changed
  }

  private async pages<T extends object>(
    first: (
      cursor: string | null,
      etag: string | null,
    ) => Promise<{
      items: Array<T>
      next: string | null
      etag: string | null
      notModified: boolean
    }>,
    o: {
      full: boolean
      since: number
      etags: Record<string, string>
      key: string
    },
  ) {
    const all: Array<T> = []
    let cursor: string | null = null
    let complete = false
    for (let page = 0; page < FIRST_PAGES; page++) {
      const res = await first(
        cursor,
        page === 0 && !o.full ? (o.etags[o.key] ?? null) : null,
      )
      if (page === 0 && res.etag) o.etags[o.key] = res.etag
      if (res.notModified)
        return { items: all, complete: false, unchanged: true }
      all.push(...res.items)
      const older = res.items.some(
        (i) => ((i as { updated?: number }).updated ?? Infinity) < o.since,
      )
      if (!res.next) {
        complete = true
        break
      }
      if (!o.full && older) break
      cursor = res.next
    }
    return { items: all, complete, unchanged: false }
  }

  private async removeMissing(r: RemoteRec, kind: ItemKind, seen: Set<string>) {
    for (const i of await this.store.itemsOf(r.repo, kind, 5000))
      if (!seen.has(i.key) && !i.removed)
        await this.store.markRemoved(r.repo, kind, i.key, this.sync.now(), null)
  }

  private async pulls(
    r: RemoteRec,
    forge: ForgeProvider,
    auth: ProviderAuth,
    o: { full: boolean; since: number; etags: Record<string, string> },
  ) {
    const got = await this.pages(
      (cursor, etag) => forge.listPulls(auth, r.fullName, { cursor, etag }),
      { ...o, key: 'pulls' },
    )
    let changed = 0
    for (const p of got.items) {
      if (!o.full && p.updated < o.since) continue
      const key = String(p.number)
      const prev = await this.store.item(r.repo, 'pull', key)
      const next = remotePullState(p)
      const state =
        remotePullTarget(
          (prev?.state as ChangeState | undefined) ?? null,
          next,
        ) ?? (prev?.state as ChangeState)
      const commitsHere = await this.hasCommit(r.repo, p.head.sha).catch(
        () => null,
      )
      const put = await this.store.putItem(r.repo, {
        kind: 'pull',
        number: p.number,
        key,
        title: p.title,
        body: p.body,
        state,
        authorId: await this.actor(r, p.author),
        labels: p.labels ?? [],
        url: p.url,
        created: p.created,
        updated: p.updated,
        closed: p.closed,
        merged: p.merged,
        head: {
          ref: p.head.ref,
          sha: p.head.sha,
          base: p.base.ref,
          fromFork: p.head.fromFork,
          commitsHere,
        },
        flags: { draft: p.draft, prerelease: false },
      })
      const id =
        put ??
        (o.full
          ? ((await this.store.item(r.repo, 'pull', key))?.id ?? null)
          : null)
      if (!id) continue
      changed++
      if (commitsHere === false) {
        const text = await forge
          .pullPatch(auth, r.fullName, p.number)
          .catch(() => null)
        if (text) await this.store.putPatch(id, text)
      }
      const comments = await forge.listComments(
        auth,
        r.fullName,
        p.number,
        'pull',
      )
      await this.comments_(r, id, comments)
      await this.materialize?.(r.repo, {
        kind: 'pull',
        host: r.provider,
        number: p.number,
        title: p.title,
        description: p.body,
        state,
        author: who(p.author),
        base: p.base.ref,
        branch: p.head.ref,
        headSha: p.head.sha,
        created: p.created,
        updated: p.updated,
        landed: p.merged,
        files: forge.pullFiles
          ? await forge.pullFiles(auth, r.fullName, p.number).catch(() => null)
          : null,
        comments: comments.map((c) => ({
          id: c.id,
          author: who(c.author),
          body: c.body,
          created: c.created,
        })),
        labels: p.labels ?? [],
        reviews: forge.listReviews
          ? (
              await forge
                .listReviews(auth, r.fullName, p.number)
                .catch(() => [])
            ).map((x) => ({ ...x, author: who(x.author) }))
          : [],
        lineComments: forge.listReviewComments
          ? (
              await forge
                .listReviewComments(auth, r.fullName, p.number)
                .catch(() => [])
            ).map((x) => ({ ...x, author: who(x.author) }))
          : [],
      })
    }
    if (o.full && got.complete)
      await this.removeMissing(
        r,
        'pull',
        new Set(got.items.map((p) => String(p.number))),
      )
    return changed
  }

  private async issues(
    r: RemoteRec,
    forge: ForgeProvider,
    auth: ProviderAuth,
    o: { full: boolean; since: number; etags: Record<string, string> },
  ) {
    const got = await this.pages(
      (cursor, etag) => forge.listIssues(auth, r.fullName, { cursor, etag }),
      { ...o, key: 'issues' },
    )
    let changed = 0
    for (const i of got.items) {
      if (!o.full && i.updated < o.since) continue
      if (await this.issueIn(r, forge, auth, i, o.full)) changed++
    }
    if (o.full && got.complete)
      await this.removeMissing(
        r,
        'issue',
        new Set(got.items.map((i) => String(i.number))),
      )
    return changed
  }

  /** One issue from the provider into Issues here, with its comments. */
  private async issueIn(
    r: RemoteRec,
    forge: ForgeProvider,
    auth: ProviderAuth,
    i: RemoteIssue,
    full: boolean,
  ) {
    const put = await this.store.putItem(r.repo, {
      kind: 'issue',
      number: i.number,
      key: String(i.number),
      title: i.title,
      body: i.body,
      state: i.state,
      authorId: await this.actor(r, i.author),
      labels: i.labels,
      url: i.url,
      created: i.created,
      updated: i.updated,
      closed: i.closed,
      merged: null,
      head: null,
      flags: null,
    })
    const id =
      put ??
      (full
        ? ((await this.store.item(r.repo, 'issue', String(i.number)))?.id ??
          null)
        : null)
    if (!id) return false
    const comments = await forge.listComments(
      auth,
      r.fullName,
      i.number,
      'issue',
    )
    await this.comments_(r, id, comments)
    await this.materialize?.(r.repo, {
      kind: 'issue',
      host: r.provider,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      author: who(i.author),
      labels: i.labels,
      closedAs: i.closedAs ?? null,
      assignees: (i.assignees ?? []).map((a) => who(a)!),
      created: i.created,
      updated: i.updated,
      closed: i.closed,
      comments: comments.map((c) => ({
        id: c.id,
        author: who(c.author),
        body: c.body,
        created: c.created,
        updated: c.updated,
      })),
    })
    return true
  }

  /**
   * Open an issue on the provider of a linked repository and bring it here,
   * so it has the provider's number and both sides show the same issue.
   * Null when the repository is not linked to a provider that can.
   */
  async createIssue(
    full: string,
    issue: { title: string; body: string; labels: Array<string> },
    by: string,
  ): Promise<number | null> {
    const r = await this.store.remoteOfRepo(full)
    if (!r || r.state === 'gone' || r.state === 'archived') return null
    const forge = this.sync.forge(r.provider)
    if (!forge.createIssue) return null
    const auth = await this.sync.authOf(r)
    if (!auth) return null
    const made = await forge.createIssue(auth, r.fullName, {
      title: issue.title,
      body: `${issue.body}${issue.body ? '\n\n' : ''}<sub>Opened on cobalt by @${by}.</sub>`,
      labels: issue.labels,
    })
    await this.issueIn(r, forge, auth, made, true)
    return made.number
  }

  /** The provider of a linked repository that can take issue writes. */
  private async writable(full: string) {
    const r = await this.store.remoteOfRepo(full)
    if (!r || r.state === 'gone' || r.state === 'archived') return null
    const forge = this.sync.forge(r.provider)
    const auth = await this.sync.authOf(r)
    return auth ? { r, forge, auth } : null
  }

  /** Change an issue on the provider first, then read it back here. */
  async updateIssue(
    full: string,
    number: number,
    patch: {
      title?: string
      body?: string
      labels?: Array<string>
      state?: 'open' | 'closed'
    },
  ): Promise<boolean> {
    const w = await this.writable(full)
    if (!w?.forge.updateIssue) return false
    const made = await w.forge.updateIssue(w.auth, w.r.fullName, number, patch)
    await this.issueIn(w.r, w.forge, w.auth, made, true)
    return true
  }

  /** Comment on the provider's issue, then read the issue back here. */
  async commentIssue(
    full: string,
    number: number,
    body: string,
    by: string,
  ): Promise<string | null> {
    const w = await this.writable(full)
    if (!w?.forge.createComment || !w.forge.getIssue) return null
    const made = await w.forge.createComment(
      w.auth,
      w.r.fullName,
      number,
      `${body}\n\n<sub>@${by} on cobalt.</sub>`,
    )
    const issue = await w.forge.getIssue(w.auth, w.r.fullName, number)
    await this.issueIn(w.r, w.forge, w.auth, issue, true)
    return made.id
  }

  private async releases(
    r: RemoteRec,
    forge: ForgeProvider,
    auth: ProviderAuth,
    o: { full: boolean; etags: Record<string, string> },
  ) {
    const got = await this.pages(
      (cursor, etag) => forge.listReleases(auth, r.fullName, { cursor, etag }),
      { ...o, since: 0, key: 'releases', full: true },
    )
    if (got.unchanged) return 0
    let changed = 0
    for (const x of got.items) {
      const put = await this.store.putItem(r.repo, {
        kind: 'release',
        number: 0,
        key: x.id,
        title: x.name,
        body: x.body,
        state: x.draft ? 'draft' : 'published',
        authorId: await this.actor(r, x.author),
        labels: [x.tag],
        url: x.url,
        created: x.created,
        updated: x.published ?? x.created,
        closed: x.published,
        merged: null,
        head: null,
        flags: { draft: x.draft, prerelease: x.prerelease },
      })
      const id =
        put ?? (await this.store.item(r.repo, 'release', x.id))?.id ?? null
      if (!id) continue
      changed++
      if (!x.draft)
        await this.materialize?.(r.repo, {
          kind: 'release',
          host: r.provider,
          externalId: x.id,
          tag: x.tag,
          title: x.name,
          body: x.body,
          prerelease: x.prerelease,
          author: who(x.author),
          published: x.published ?? x.created,
          assets: x.assets ?? [],
        })
    }
    if (got.complete)
      await this.removeMissing(
        r,
        'release',
        new Set(got.items.map((x) => x.id)),
      )
    return changed
  }

  private async checks(r: RemoteRec, forge: ForgeProvider, auth: ProviderAuth) {
    if (!forge.checksOf || !this.materialize) return
    const open = (await this.store.itemsOf(r.repo, 'pull', 200)).filter(
      (p) => (p.state === 'open' || p.state === 'draft') && p.head,
    )
    for (const p of open.slice(0, 50)) {
      const checks = await forge
        .checksOf(auth, r.fullName, p.head!.sha)
        .catch(() => null)
      if (checks)
        await this.materialize(r.repo, {
          kind: 'checks',
          host: r.provider,
          number: p.number,
          checks,
        })
    }
  }

  async onEvent(
    r: RemoteRec,
    ev: Extract<
      WebhookEvent,
      { kind: 'pull_request' | 'issues' | 'release' | 'comment' | 'checks' }
    >,
  ) {
    if (
      ev.action === 'deleted' &&
      ev.number !== null &&
      ev.kind !== 'comment' &&
      ev.kind !== 'checks'
    ) {
      const kind: ItemKind =
        ev.kind === 'pull_request'
          ? 'pull'
          : ev.kind === 'issues'
            ? 'issue'
            : 'release'
      if (kind !== 'release')
        await this.store.markRemoved(
          r.repo,
          kind,
          String(ev.number),
          this.sync.now(),
          await this.actor(r, ev.actor),
        )
    }
    if (ev.action === 'deleted')
      await this.store.patchRemote(r.id, { importedAt: null })
    await this.store.setItemsDue(r.repo, this.sync.now())
  }
}
