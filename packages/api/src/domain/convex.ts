import { handoffPlan, reviewPlan } from '../agent-runs'
import { isTriggerFile } from '../trigger-file'
import { POLICY_FILE } from '../policy-file'
import type { Planned } from '../actions'
import { LICENSE_FILES, languagesOf, licenseOf } from '../detect'
import { isWorkflowFile, planPush, runOf } from '../actions'
import { codeStorageRemotes } from '@cobaltforge/git/remote'
import { copyHistory } from '@cobaltforge/git/transfer'
import { groupAuthors } from '../contributors'
import { receiptFor } from '../receipt'
import { runsOnOf } from '../workflow'
import { INBOX_MAX, dashboardNeeds, needsFrom, presentInbox } from '../inbox'
import type { NeedsFacts } from '../inbox'
import type { Upstream } from '@cobaltforge/git/stores'
import { labelOf } from '../forge/sync'
import { forgeOps } from '../forge/ports'
import { declareSecrets } from '../forge/secrets'
import { extrasScope } from '../stores/convex-extras'

const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
  extrasScope.getStore() ? fn() : extrasScope.run(new Set(), fn)
import type { Prepared, SyncHost } from '../forge/sync'
import type { ProviderId } from '../forge/types'
import { ConvexError } from 'convex/values'
import { ApiError, apiError } from '../problem'
import { Pre } from '../registry'
import { pageSorted } from '../cursor'
import { heldKey } from '../idempotency'
import { healthAreas, reportFrom } from '../health'
import type { HealthReader } from '../health'
import { hiddenEvent, parseEvent } from '../events'
import type { StoredEvent } from '../events'
import type { SearchDoc } from '../search'
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
import { seqId } from './records'
import { statusReport } from './status-report'
import type { ErrorCode } from '../problem'
import type { Principal } from '../auth'
import { Moved } from './records'
import type { Attached, Urls, Viewer } from './records'
import type { EventLog } from '../events'
import type { DomainPort } from './port'
import type * as S from '../schemas'
import type { z } from 'zod'

export type ConvexCall = (
  kind: 'query' | 'mutation' | 'action',
  name: string,
  args: Record<string, unknown>,
  who: Viewer | 'system',
) => Promise<unknown>

export function claimsOf(who: Principal | 'system') {
  if (who === 'system')
    return { subject: '~system', cb_api: 'true', cb_sys: 'true', cb_scp: '' }
  const via = receiptFor(who)
  const claims: Record<string, string> = {
    subject: who.handle,
    cb_api: 'true',
    cb_tok: who.tokenId,
    cb_login: who.loginId,
    cb_act: who.actingAs,
    cb_scp: [...who.scopes].join(' '),
  }
  if (via.machine) claims.cb_dev = via.machine
  if (via.tool) claims.cb_tool = via.tool
  if (via.model) claims.cb_model = via.model
  if (who.session) claims.cb_ses = 'true'
  if (who.repos) claims.cb_rep = who.repos.join(',')
  if (who.paths) claims.cb_pth = JSON.stringify(who.paths)
  if (who.runnerId) claims.cb_run = who.runnerId
  const held = heldKey.getStore()
  if (held) claims.cb_idem = JSON.stringify([held.scope, held.key, held.lease])
  return claims
}

type Refusal = { code: string; detail: string; more?: string }

function refusal(e: unknown): (Refusal & Record<string, unknown>) | null {
  const data =
    e instanceof ConvexError
      ? (e.data as unknown)
      : e && typeof e === 'object' && 'data' in e
        ? e.data
        : null
  if (data && typeof data === 'object' && 'code' in data && 'detail' in data)
    return data as Refusal & Record<string, unknown>
  return null
}

export async function run<T>(
  call: ConvexCall,
  kind: 'query' | 'mutation' | 'action',
  name: string,
  args: Record<string, unknown>,
  who: Viewer | 'system',
): Promise<T> {
  try {
    const text = await call(kind, name, args, who)
    return (typeof text === 'string' ? JSON.parse(text) : text) as T
  } catch (e) {
    const r = refusal(e)
    if (!r) throw e
    if (r.code === 'dry_run') return JSON.parse(r.value as string) as T
    if (r.code === 'moved') throw new Moved(r.from as string, r.to as string)
    const more = r.more ? (JSON.parse(r.more) as Record<string, never>) : {}
    throw apiError(r.code as ErrorCode, r.detail, more)
  }
}

function upstreamProblem(
  e: unknown,
  upstream?: { owner: string; name: string; provider?: string } | string,
) {
  const err = e as { status?: number; code?: string; message?: string }
  const provider =
    typeof upstream === 'string' ? upstream : (upstream?.provider ?? 'github')
  const label = labelOf(provider)
  const where =
    upstream && typeof upstream !== 'string'
      ? `${provider === 'github' ? 'github.com' : label}/${upstream.owner}/${upstream.name}`
      : `the ${label} repository`
  if (err.code === 'github_repository_inaccessible' || err.status === 412)
    return apiError('forbidden', `Code Storage cannot reach ${where}.`, {
      hint:
        provider === 'github'
          ? 'Install the Cobalt GitHub App on that repository.'
          : `Connect ${label} again: the stored token may have expired.`,
    })
  if (e instanceof Error && e.name === 'GitNotConfigured')
    return apiError('backend_unavailable', e.message)
  return apiError(
    'backend_unavailable',
    `Code Storage did not complete the request${err.status ? ` (${err.status})` : ''}.`,
  )
}

type Port = DomainPort

export class ConvexDomain implements DomainPort {
  accessRevision = 0
  constructor(
    readonly urls: Urls,
    readonly call: ConvexCall,
    readonly events: EventLog,
    readonly svc: Attached,
    protected readonly now: () => number = Date.now,
  ) {}

  protected q<T>(
    name: string,
    args: Record<string, unknown>,
    p: Viewer | 'system',
  ) {
    return run<T>(this.call, 'query', `forge/${name}`, args, p)
  }

  protected m<T>(
    name: string,
    args: Record<string, unknown>,
    p: Viewer | 'system',
  ) {
    return run<T>(this.call, 'mutation', `forge/${name}`, args, p)
  }

  private searchSource: Array<SearchDoc> = []

  searchDocs: Port['searchDocs'] = () => this.searchSource

  async refreshSearch(call: ConvexCall = this.call) {
    const docs: Array<SearchDoc> = []
    let after: string | null = null
    do {
      const page: { docs: Array<SearchDoc>; next: string | null } = await run(
        call,
        'query',
        'forge/search:docs',
        { after, repos: 20 },
        'system',
      )
      docs.push(...page.docs)
      after = page.next
    } while (after)
    this.searchSource = docs
    this.svc.search.reset()
  }

  private async reindex<T>(done: Promise<T>, dry?: boolean) {
    const r = await done
    if (!dry) await this.refreshSearch()
    return r
  }

  async sweepOperations() {
    await this.m('operations:sweepNow', {}, 'system')
  }

  listAccounts: Port['listAccounts'] = (p) => this.q('accounts:list', {}, p)
  getAccount: Port['getAccount'] = (handle, p) =>
    this.q('accounts:get', { handle }, p)
  accountVersion: Port['accountVersion'] = (handle) =>
    this.q('accounts:version', { handle }, null)
  knowPerson: Port['knowPerson'] = (handle, name) =>
    this.m('accounts:knowPerson', { handle, name }, 'system')
  updateAccount: Port['updateAccount'] = (handle, p, body, ifMatch, dry) =>
    this.reindex(
      this.m('accounts:update', { handle, ...body, ifMatch, dry }, p),
      dry,
    )
  createOrganization: Port['createOrganization'] = (p, input, dry) =>
    this.reindex(
      this.m('accounts:createOrganization', { ...input, dry }, p),
      dry,
    )
  listMembers: Port['listMembers'] = (handle, p) =>
    this.q('accounts:listMembers', { handle }, p)
  membersVersion: Port['membersVersion'] = (handle, p) =>
    this.q('accounts:membersVersion', { handle }, p)
  setMember: Port['setMember'] = (handle, login, role, p, dry) =>
    this.reindex(
      this.m('accounts:setMember', { handle, login, role, dry }, p),
      dry,
    )
  removeMember: Port['removeMember'] = (handle, login, p, dry) =>
    this.reindex(
      this.m('accounts:removeMember', { handle, login, dry }, p),
      dry,
    )
  listInvitations: Port['listInvitations'] = (handle, p) =>
    this.q('accounts:listInvitations', { handle, at: this.now() }, p)
  invite: Port['invite'] = (handle, p, input, dry) =>
    this.m('accounts:invite', { handle, ...input, dry }, p)
  revokeInvitation: Port['revokeInvitation'] = (handle, id, p, dry) =>
    this.m('accounts:revokeInvitation', { handle, id, dry }, p)
  acceptInvitation: Port['acceptInvitation'] = (secret, p, dry) =>
    this.reindex(this.m('accounts:acceptInvitation', { secret, dry }, p), dry)

  canActAs: Port['canActAs'] = (login, account) =>
    this.q('repos:canActAs', { login, account }, 'system')
  mayReadId: Port['mayReadId'] = (id, p) => this.q('repos:mayReadId', { id }, p)
  repoAccess: Port['repoAccess'] = (owner, name, p, need) =>
    this.q('repos:access', { owner, name, need, strict: false }, p)
  secretsAccess: Port['secretsAccess'] = (owner, name, p) =>
    this.q('extras:secretsAccess', { owner, name }, p)
  repoAccessStrict: Port['repoAccessStrict'] = (
    owner,
    name,
    p,
    need = 'read',
  ) => this.q('repos:access', { owner, name, need, strict: true }, p)
  replayKey: Port['replayKey'] = (opId, params, p) =>
    this.q(
      'repos:replayKey',
      { opId, owner: params.owner, name: params.repo },
      p,
    )
  repoIdForHistory: Port['repoIdForHistory'] = (full) =>
    this.q('repos:idForHistory', { full }, 'system')
  canonicalRepoName: Port['canonicalRepoName'] = (full) =>
    this.q('repos:canonicalName', { full }, 'system')

  assertVersion: Port['assertVersion'] = (ifMatch, version, current) => {
    if (ifMatch === null) return
    const tags = ifMatch
      .split(',')
      .map((t) => t.trim().replace(/^W\//, '').replace(/"/g, ''))
    if (
      tags.includes('*') ||
      tags.some(
        (t) =>
          t === version ||
          t.startsWith(`${version}-`) ||
          t.startsWith(`${version}.`),
      )
    )
      return
    throw apiError(
      'version_mismatch',
      'The object changed since you read it.',
      {
        extra: { current: current() },
      },
    )
  }

  listRepos: Port['listRepos'] = (p, q) => {
    const at = this.now()
    return this.q('repos:list', { ...q, at: at - (at % 60_000) }, p)
  }
  getRepo: Port['getRepo'] = (owner, name, p) =>
    this.q('repos:get', { owner, name, at: this.now() }, p)
  gitAccess: Port['gitAccess'] = (owner, name, p, need) =>
    this.q('repos:gitAccess', { owner, name, need }, p)
  repoVersion: Port['repoVersion'] = (owner, name, p) =>
    this.q('repos:version', { owner, name }, p)
  changeListVersion: Port['changeListVersion'] = (owner, name, p) =>
    this.q('repos:listVersion', { owner, name, of: 'changes' }, p)
  issueListVersion: Port['issueListVersion'] = (owner, name, p) =>
    this.q('repos:listVersion', { owner, name, of: 'issues' }, p)
  repoIdOf: Port['repoIdOf'] = (owner, name, p) =>
    this.q('repos:idOf', { owner, name }, p)
  getStar: Port['getStar'] = (owner, name, p) =>
    this.q('repos:getStar', { owner, name }, p)
  setStar: Port['setStar'] = (owner, name, p, on, dry) =>
    this.m('repos:setStar', { owner, name, on, dry }, p)
  bumpRepo: Port['bumpRepo'] = (owner, name, p) =>
    this.m('repos:bump', { owner, name }, p)
  createRepo: Port['createRepo'] = (p, input, dry) =>
    this.createRepoWith(p, input, dry)

  private async createRepoWith(
    p: Principal,
    input: Parameters<Port['createRepo']>[1],
    dry: boolean,
    link?: { upstream: Upstream; defaultBranch: string },
  ) {
    const r = await this.m<Awaited<ReturnType<Port['createRepo']>>>(
      'repos:create',
      { ...input, dry },
      p,
    )
    if (dry) return r
    if (!link || r.created)
      try {
        await this.svc.git.provision?.(r.repo.id, link)
      } catch (e) {
        if (link && r.created)
          await this.deleteRepo(
            r.repo.owner,
            r.repo.name,
            p,
            r.repo.full_name,
            false,
          ).catch(() => undefined)
        throw upstreamProblem(e, link?.upstream)
      }
    if (r.created) {
      this.svc.git.setRepo?.(r.repo.full_name, r.repo.id)
      await this.refreshSearch()
    }
    return r
  }

  updateRepo: Port['updateRepo'] = async (
    owner,
    name,
    p,
    body,
    ifMatch,
    dry,
  ) => {
    const before = await this.repoAccess(owner, name, p, 'read')
    const r = await this.m<Awaited<ReturnType<Port['updateRepo']>>>(
      'repos:update',
      { owner, name, body, ifMatch, dry },
      p,
    )
    if (!dry) this.moved(before, r.full_name)
    if (!dry) await this.refreshSearch()
    return r
  }
  transferRepo: Port['transferRepo'] = async (owner, name, p, body, dry) => {
    const before = await this.repoAccess(owner, name, p, 'read')
    const r = await this.m<Awaited<ReturnType<Port['transferRepo']>>>(
      'repos:transfer',
      {
        owner,
        name,
        to: body.owner,
        toName: body.name,
        confirm: body.confirm,
        dry,
      },
      p,
    )
    if (!dry) this.moved(before, r.full_name)
    if (!dry) await this.refreshSearch()
    return r
  }
  deleteRepo: Port['deleteRepo'] = async (owner, name, p, confirm, dry) => {
    const r = await this.m<Awaited<ReturnType<Port['deleteRepo']>>>(
      'repos:remove',
      { owner, name, confirm, dry },
      p,
    )
    if (r.deleted) {
      const id = (r as { id?: string }).id
      if (id) await this.svc.uploads.dropRepo(id)
      void this.svc.auth.dropRepo(r.full)
      this.svc.git.dropRepo?.(r.full)
      this.svc.hooks.dropRepo(r.full)
      this.svc.extras.drop(r.full)
      await this.refreshSearch()
    }
    return r
  }

  numberRef: Port['numberRef'] = (owner, name, n, p) =>
    this.q('repos:numberRef', { owner, name, number: n }, p)
  commitFacts: Port['commitFacts'] = (full, commits) =>
    this.q(
      'repos:commitFacts',
      {
        full,
        commits: commits.map((c) => ({ sha: c.sha, email: c.author.email })),
      },
      'system',
    )
  context: Port['context'] = async (owner, name, p) => {
    const r = await this.q<{
      repo: Awaited<ReturnType<Port['context']>>['repo']
      changes: Awaited<ReturnType<Port['context']>>['changes']
      issues: Awaited<ReturnType<Port['context']>>['issues']
      envAllowed: boolean
      full: string
      id: string
    }>('repos:context', { owner, name, at: this.now() }, p)
    return {
      object: 'context',
      repo: r.repo,
      changes: r.changes,
      issues: r.issues,
      policy: { rules: 4, mode: 'enforce' },
      env: r.envAllowed
        ? (await this.svc.extras.open(r.full)).env.map((x) => ({
            name: x.name,
            kind: x.kind,
            set: [...x.set],
          }))
        : [],
      cursor: `e_${r.id}_${this.events.head}`,
    }
  }

  private moved(from: string, to: string) {
    if (from === to) return
    void this.svc.auth.renameRepo(from, to)
    const storeId = this.svc.git.storeOf?.(from)
    if (storeId) this.svc.git.setRepo?.(to, storeId)
    if (from.toLowerCase() !== to.toLowerCase()) this.svc.git.dropRepo?.(from)
    this.svc.hooks.rename(from, to)
    this.svc.extras.rename(from, to)
  }

  listIssues: Port['listIssues'] = async (owner, name, p, q) => {
    const page = await this.q<{
      items: Array<{ id: string; version: number }>
      next: never
    }>('issues:list', { owner, name, ...q }, p)
    return {
      items: page.items.map(
        (x) => new Pre(JSON.stringify(x), x, `${x.id}|${x.version}`),
      ),
      next: page.next,
    }
  }
  getIssue: Port['getIssue'] = (owner, name, n, p) =>
    this.q('issues:get', { owner, name, number: n }, p)
  issueVersion: Port['issueVersion'] = (owner, name, n, p) =>
    this.q('issues:version', { owner, name, number: n }, p)
  createIssue: Port['createIssue'] = async (owner, name, p, body, dry) => {
    // A repository linked to GitHub opens the issue there first: it gets
    // GitHub's number, so the two never number different issues alike.
    if (!dry && p && this.svc.providers) {
      const full = await this.repoAccess(owner, name, p, 'read')
      const link = await this.svc.providers.store.remoteOfRepo(full)
      if (link?.provider === 'github') {
        const same = (
          await this.q<{ items: Array<{ number: number; title: string }> }>(
            'issues:list',
            { owner, name, state: 'open', after: null, limit: 100 },
            p,
          ).catch(() => ({ items: [] }))
        ).items.find((i) => i.title === body.title)
        if (same)
          return {
            issue: await this.getIssue(owner, name, same.number, p),
            outcome: 'unchanged',
          }
        const n = await this.svc.providers.items
          .createIssue(
            full,
            {
              title: body.title,
              body: body.body ?? '',
              labels: body.labels ?? [],
            },
            p.handle,
          )
          .catch((e: unknown) => {
            throw this.svc.providers!.providerProblem(e)
          })
        if (n !== null) {
          const issue = await this.getIssue(owner, name, n, p).catch(() => {
            throw apiError(
              'backend_unavailable',
              `Opened on GitHub as #${n}; it shows here once GitHub answers again.`,
              {
                retryAfter: 60,
                hint: 'Sending it again is safe: the same title by you in the last minutes is the same issue.',
              },
            )
          })
          return { issue, outcome: 'created' }
        }
      }
    }
    return this.m('issues:create', { owner, name, ...body, dry }, p)
  }
  updateIssue: Port['updateIssue'] = async (
    owner,
    name,
    n,
    p,
    body,
    ifMatch,
    dry,
  ) => {
    const local = (b: typeof body, match: typeof ifMatch) =>
      this.m<z.infer<typeof S.Issue>>(
        'issues:update',
        {
          owner,
          name,
          number: n,
          body: b,
          fields: Object.keys(b),
          ifMatch: match,
          dry,
        },
        p,
      )
    // An issue of a repository linked to GitHub changes there first, then
    // comes back here, so both sides agree.
    const synced = await this.issueOnGithub(owner, name, n, p)
    if (dry || !synced) return local(body, ifMatch)
    if (ifMatch !== null) {
      const now = await this.getIssue(owner, name, n, p)
      if (String(now.version) !== String(ifMatch).replace(/"/g, ''))
        return local(body, ifMatch)
    }
    const { assignees, ...there } = body
    if (Object.keys(there).length)
      await synced.items
        .updateIssue(synced.full, n, there, p!.handle)
        .catch((e: unknown) => {
          throw synced.problem(e)
        })
    if (assignees) return local({ assignees }, null)
    return this.getIssue(owner, name, n, p)
  }

  /** The sync for an issue that came from (or went to) GitHub, if any. */
  private async issueOnGithub(
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) {
    const sync = this.svc.providers
    if (!sync || !p) return null
    const full = await this.repoAccess(owner, name, p, 'read')
    const link = await sync.store.remoteOfRepo(full)
    if (link?.provider !== 'github') return null
    const issue = await this.getIssue(owner, name, n, p).catch(() => null)
    if (!issue?.id.startsWith('iss_github_')) return null
    return {
      full,
      items: sync.items,
      problem: (e: unknown) => sync.providerProblem(e),
    }
  }
  listLabels: Port['listLabels'] = (owner, name, p) =>
    this.q('issues:listLabels', { owner, name }, p)
  labelsVersion: Port['labelsVersion'] = (owner, name, p) =>
    this.q('issues:labelsVersion', { owner, name }, p)
  createLabel: Port['createLabel'] = (owner, name, p, body, dry) =>
    this.m(
      'issues:createLabel',
      {
        owner,
        name,
        label: body.name,
        color: body.color,
        description: body.description,
        dry,
      },
      p,
    )
  updateLabel: Port['updateLabel'] = (owner, name, label, p, body, dry) =>
    this.m('issues:updateLabel', { owner, name, label, body, dry }, p)
  deleteLabel: Port['deleteLabel'] = (owner, name, label, p, dry) =>
    this.m('issues:deleteLabel', { owner, name, label, dry }, p)
  listComments: Port['listComments'] = (owner, name, n, p, q) =>
    this.q('issues:listComments', { owner, name, number: n, ...q }, p)
  commentsVersion: Port['commentsVersion'] = (owner, name, n, p) =>
    this.q('issues:commentsVersion', { owner, name, number: n }, p)
  createComment: Port['createComment'] = async (
    owner,
    name,
    n,
    p,
    body,
    dry,
  ) => {
    const synced = dry ? null : await this.issueOnGithub(owner, name, n, p)
    if (synced && p) {
      const id = await synced.items
        .commentIssue(synced.full, n, body.body, p.handle)
        .catch((e: unknown) => {
          throw synced.problem(e)
        })
      if (id) {
        const all = await this.listComments(owner, name, n, p, {
          after: null,
          limit: 200,
        })
        const mine = all.items.find((c) => c.id === `cmt_github_${id}`)
        if (mine) return mine
      }
    }
    return this.m(
      'issues:createComment',
      { owner, name, number: n, body: body.body, dry },
      p,
    )
  }
  updateComment: Port['updateComment'] = (
    owner,
    name,
    id,
    p,
    body,
    ifMatch,
    dry,
  ) =>
    this.m(
      'issues:updateComment',
      { owner, name, id, body: body.body, ifMatch, dry },
      p,
    )
  deleteComment: Port['deleteComment'] = (owner, name, id, p, dry) =>
    this.m('issues:deleteComment', { owner, name, id, dry }, p)
  addIssueEvidence: Port['addIssueEvidence'] = async (
    owner,
    name,
    n,
    p,
    input,
    dry,
  ) => {
    const u = input.upload
    const r = await this.m<{
      evidence: Awaited<ReturnType<Port['addIssueEvidence']>>
      repo: string
      repoId: string
    }>(
      'issues:addEvidence',
      {
        owner,
        name,
        number: n,
        kind: input.kind,
        caption: input.caption,
        upload: {
          id: u.id,
          contentType: u.contentType,
          size: u.size,
          sha256: u.sha256 ?? '',
        },
        dry,
      },
      p,
    )
    if (!dry) {
      u.attachedTo = r.repo
      u.attachedRepoId = r.repoId
    }
    return r.evidence
  }
  listIssueEvidence: Port['listIssueEvidence'] = async (
    owner,
    name,
    n,
    p,
    find,
  ) => {
    const all = await this.q<
      Array<{
        uploadId: string
        shown: Awaited<ReturnType<Port['listIssueEvidence']>>[number]
      }>
    >('issues:listEvidence', { owner, name, number: n }, p)
    const shown = []
    for (const e of all) if (await find(e.uploadId)) shown.push(e.shown)
    return shown
  }

  private pre<T extends { id: string; version?: number }>(x: T) {
    return new Pre(JSON.stringify(x), x, `${x.id}|${x.version ?? 0}`)
  }

  listChanges: Port['listChanges'] = async (owner, name, p, q) => {
    const page = await this.q<{
      items: Array<{ id: string; version: number }>
      next: never
    }>(
      'changes:list',
      { owner, name, ...q, expand: [...q.expand], at: this.now() },
      p,
    )
    return { items: page.items.map((x) => this.pre(x)), next: page.next }
  }
  getChange: Port['getChange'] = async (owner, name, ref, p, expand = []) =>
    this.pre(
      await this.q<{ id: string; version: number }>(
        'changes:get',
        { owner, name, ref, expand: [...expand], at: this.now() },
        p,
      ),
    )
  changeVersion: Port['changeVersion'] = (owner, name, ref, p, expand = []) =>
    this.q('changes:version', { owner, name, ref, expand: [...expand] }, p)
  getGuide: Port['getGuide'] = (owner, name, ref, p) =>
    this.q('changes:guide', { owner, name, ref }, p)
  putGuide: Port['putGuide'] = (owner, name, ref, p, body, dry) =>
    this.m('changes:putGuide', { owner, name, ref, ...body, dry }, p)
  changeSeen: Port['changeSeen'] = (owner, name, ref, p) =>
    this.q('changes:seen', { owner, name, ref }, p)
  setSeen: Port['setSeen'] = (owner, name, ref, p, body, dry) =>
    this.m('changes:setSeen', { owner, name, ref, ...body, dry }, p)
  presence: Port['presence'] = (owner, name, subject, p) =>
    this.q('presence:list', { owner, name, ...subject }, p)
  heartbeat: Port['heartbeat'] = (owner, name, subject, p, body) =>
    this.m('presence:heartbeat', { owner, name, ...subject, ...body }, p)
  timeline: Port['timeline'] = (owner, name, subject, p) =>
    this.q(
      'timelines:get',
      { owner, name, kind: subject.kind, ref: subject.ref, at: this.now() },
      p,
    )
  provenance: Port['provenance'] = (owner, name, p, q) =>
    this.q('changes:provenance', { owner, name, ...q, at: this.now() }, p)
  createChange: Port['createChange'] = async (owner, name, p, body) => {
    const { dry_run, ...rest } = body
    // A repository linked to GitHub opens the pull request there first, so
    // the change has GitHub's number (issues and pull requests share them).
    if (!dry_run && p && this.svc.providers && !body.sha) {
      const full = await this.repoAccess(owner, name, p, 'write')
      const link = await this.svc.providers.store.remoteOfRepo(full)
      if (link?.provider === 'github') {
        const repo = await this.q<{ default_branch: string }>(
          'repos:get',
          { owner, name, at: this.now() },
          p,
        )
        const n = await this.svc.providers.items
          .createPull(
            full,
            {
              head: body.branch,
              base: body.base ?? repo.default_branch,
              title: body.title ?? body.branch,
              body: body.description ?? '',
              draft: body.draft ?? false,
            },
            p.handle,
          )
          .catch((e: unknown) => {
            throw this.svc.providers!.providerProblem(e)
          })
        if (n !== null) {
          const change = await this.q<z.infer<typeof S.Change>>(
            'changes:get',
            { owner, name, ref: String(n), expand: [], at: this.now() },
            p,
          ).catch(() => {
            throw apiError(
              'backend_unavailable',
              `Opened on GitHub as #${n}; it shows here once GitHub answers again.`,
              {
                retryAfter: 60,
                hint: 'Sending it again is safe: the branch has one pull request.',
              },
            )
          })
          return { change, outcome: 'created' }
        }
      }
    }
    // The branch's real head and files, read from git; the sample has none.
    const real =
      !body.sha && p ? await this.branchDiff(owner, name, p, body) : null
    return this.m(
      'changes:create',
      {
        owner,
        name,
        ...rest,
        ...(real ? { sha: real.sha, stats: real.stats } : {}),
        dry: dry_run,
      },
      p,
    )
  }

  /** What `branch` changes against `base`, as git says: its head and files. */
  private async branchDiff(
    owner: string,
    name: string,
    p: Viewer,
    body: { branch: string; base?: string },
  ) {
    try {
      const full = await this.repoAccess(owner, name, p, 'write')
      const base =
        body.base ??
        (
          await this.q<{ default_branch: string }>(
            'repos:get',
            { owner, name, at: this.now() },
            p,
          )
        ).default_branch
      const sha = await this.svc.git.head?.(full, body.branch)
      if (!sha) return null
      const d = await this.svc.git.diff(full, sha, base)
      return { sha, stats: statsOf(d.files) }
    } catch {
      return null
    }
  }
  updateChange: Port['updateChange'] = (
    owner,
    name,
    ref,
    p,
    body,
    ifMatch,
    dry,
  ) =>
    this.m(
      'changes:update',
      { owner, name, ref, body, fields: Object.keys(body), ifMatch, dry },
      p,
    )
  transition: Port['transition'] = (owner, name, ref, p, action, dry) =>
    this.m('changes:transition', { owner, name, ref, action, dry }, p)
  autoLandCandidate: Port['autoLandCandidate'] = (owner, name, ref) =>
    this.q('changes:autoLandCandidate', { owner, name, ref }, 'system')
  autoLand: Port['autoLand'] = (owner, name, ref, sha) =>
    this.m('changes:autoLand', { owner, name, ref, sha }, 'system')
  land: Port['land'] = (owner, name, ref, p, body, dry) =>
    this.m(
      'changes:land',
      { owner, name, ref, expectedTree: body.expected_tree, dry },
      p,
    )
  landStack: Port['landStack'] = (owner, name, stackId, p, body, dry) =>
    this.m(
      'changes:landStack',
      { owner, name, stackId, trees: Object.entries(body.expected_trees), dry },
      p,
    )
  listPatchSets: Port['listPatchSets'] = (owner, name, ref, p) =>
    this.q('changes:listPatchSets', { owner, name, ref, at: this.now() }, p)
  getPatchSet: Port['getPatchSet'] = (owner, name, ref, n, p) =>
    this.q('changes:getPatchSet', { owner, name, ref, n, at: this.now() }, p)
  addPatchSet: Port['addPatchSet'] = (owner, name, ref, p, body, dry) =>
    this.m(
      'changes:addPatchSet',
      {
        owner,
        name,
        ref,
        sha: body.sha,
        kind: body.kind,
        note: body.note,
        files: body.files ? Object.entries(body.files) : undefined,
        addresses: body.addresses,
        dry,
      },
      p,
    )
  addressReviewComment: Port['addressReviewComment'] = (
    owner,
    name,
    ref,
    id,
    p,
    body,
    dry,
  ) =>
    this.m(
      'changes:addressReviewComment',
      { owner, name, ref, id, ...body, dry },
      p,
    )
  getPatchSetFiles: Port['getPatchSetFiles'] = async (
    owner,
    name,
    ref,
    n,
    p,
  ) => {
    const stored = await this.q<z.infer<typeof S.PatchSetFiles>>(
      'changes:getPatchSetFiles',
      { owner, name, ref, n },
      p,
    )
    if (stored.available) return stored
    return (await this.patchSetFilesFromGit(owner, name, ref, n, p)) ?? stored
  }

  /**
   * A change imported from a provider keeps no file contents, only the commit
   * of each patch set. Read them from git: the files `sha` touches since it
   * split from the base branch, as the provider shows a pull request.
   */
  private async patchSetFilesFromGit(
    owner: string,
    name: string,
    ref: string,
    n: number,
    p: Viewer,
  ): Promise<z.infer<typeof S.PatchSetFiles> | null> {
    const MAX_FILES = 300
    const MAX_BYTES = 1_000_000
    const full = await this.repoAccess(owner, name, p, 'read')
    const [change, ps] = await Promise.all([
      this.q<{ number: number; base: string }>(
        'changes:get',
        { owner, name, ref, expand: [], at: this.now() },
        p,
      ),
      this.getPatchSet(owner, name, ref, n, p),
    ])
    const diff = await this.svc.git
      .diff(full, ps.sha, change.base)
      .catch(() => null)
    if (!diff || diff.files.length > MAX_FILES) return null
    const text = (bytes: Uint8Array | null) =>
      bytes && bytes.length <= MAX_BYTES && !bytes.includes(0)
        ? new TextDecoder().decode(bytes)
        : null
    const read = (path: string, at: string | null) =>
      at
        ? this.svc.git
            .blob(full, path, at)
            .then(text)
            .catch(() => null)
        : Promise.resolve(null)
    const files = await Promise.all(
      diff.files.map(async (f) => ({
        path: f.path,
        base: f.state === 'added' ? null : await read(f.path, diff.base),
        content: f.state === 'deleted' ? null : await read(f.path, diff.sha),
      })),
    )
    return {
      object: 'patch_set_files',
      change: change.number,
      patch_set: ps.number,
      available: true,
      files: files.sort((x, y) => (x.path < y.path ? -1 : 1)),
    }
  }
  comparePatchSets: Port['comparePatchSets'] = (
    owner,
    name,
    ref,
    from,
    to,
    p,
  ) => this.q('changes:comparePatchSets', { owner, name, ref, from, to }, p)
  review: Port['review'] = (owner, name, ref, p, body, dry) =>
    this.m('changes:review', { owner, name, ref, ...body, dry }, p)
  listReviewComments: Port['listReviewComments'] = (owner, name, ref, p, q) =>
    this.q(
      'changes:listReviewComments',
      { owner, name, ref, ...q, at: this.now() },
      p,
    )
  reviewCommentsVersion: Port['reviewCommentsVersion'] = (
    owner,
    name,
    ref,
    p,
  ) => this.q('changes:reviewCommentsVersion', { owner, name, ref }, p)
  createReviewComment: Port['createReviewComment'] = (
    owner,
    name,
    ref,
    p,
    body,
    dry,
  ) =>
    this.m('changes:createReviewComment', { owner, name, ref, ...body, dry }, p)
  updateReviewComment: Port['updateReviewComment'] = (
    owner,
    name,
    ref,
    id,
    p,
    body,
    dry,
  ) =>
    this.m(
      'changes:updateReviewComment',
      { owner, name, ref, id, ...body, dry },
      p,
    )
  deleteReviewComment: Port['deleteReviewComment'] = (
    owner,
    name,
    ref,
    id,
    p,
    dry,
  ) => this.m('changes:deleteReviewComment', { owner, name, ref, id, dry }, p)
  listFindings: Port['listFindings'] = (owner, name, ref, p, state) =>
    this.q(
      'changes:listFindings',
      { owner, name, ref, state, at: this.now() },
      p,
    )
  raiseFinding: Port['raiseFinding'] = (owner, name, ref, p, body, dry) =>
    this.m('changes:raiseFinding', { owner, name, ref, ...body, dry }, p)
  setFinding: Port['setFinding'] = (
    owner,
    name,
    ref,
    finding,
    p,
    to,
    reason,
    dry,
  ) =>
    this.m(
      'changes:setFinding',
      { owner, name, ref, finding, to, reason, dry },
      p,
    )
  listChecks: Port['listChecks'] = (owner, name, ref, p) =>
    this.q('changes:listChecks', { owner, name, ref, at: this.now() }, p)
  reportCheck: Port['reportCheck'] = (owner, name, ref, p, body, dry) => {
    const { name: checkName, ...rest } = body
    return this.m(
      'changes:reportCheck',
      { owner, name, ref, ...rest, checkName, dry },
      p,
    )
  }
  policy: Port['policy'] = (owner, name, ref, p, assume) =>
    this.q(
      'changes:policy',
      {
        owner,
        name,
        ref,
        assume: assume && {
          approve: assume.approve,
          checks: assume.checks ? Object.entries(assume.checks) : undefined,
          resolve: assume.resolve,
        },
        at: this.now(),
      },
      p,
    )
  addEvidence: Port['addEvidence'] = async (
    owner,
    name,
    ref,
    p,
    input,
    dry,
  ) => {
    const u = input.upload
    const r = await this.m<{
      evidence: Awaited<ReturnType<Port['addEvidence']>>
      repo: string
      repoId: string
    }>(
      'changes:addEvidence',
      {
        owner,
        name,
        ref,
        kind: input.kind,
        caption: input.caption,
        upload: {
          id: u.id,
          contentType: u.contentType,
          size: u.size,
          sha256: u.sha256 ?? '',
        },
        dry,
      },
      p,
    )
    if (!dry) {
      u.attachedTo = r.repo
      u.attachedRepoId = r.repoId
    }
    return r.evidence
  }
  listEvidence: Port['listEvidence'] = async (owner, name, ref, p, find) => {
    const all = await this.q<
      Array<{
        uploadId: string
        shown: Awaited<ReturnType<Port['listEvidence']>>[number]
      }>
    >('changes:listEvidence', { owner, name, ref, at: this.now() }, p)
    const shown = []
    for (const e of all) if (await find(e.uploadId)) shown.push(e.shown)
    return shown
  }
  getOperation: Port['getOperation'] = (id, p) =>
    this.q('changes:getOperation', { id }, p)
  operationVersion: Port['operationVersion'] = (id, p) =>
    this.q('changes:operationVersion', { id }, p)
  operationRepoId: Port['operationRepoId'] = (id) =>
    this.q('changes:operationRepoId', { id }, 'system')

  canSeeId: Port['canSeeId'] = (p) => {
    const cache = new Map<string, Promise<boolean>>()
    return (id) => {
      if (!id) return !!p
      let ok = cache.get(id)
      if (!ok)
        cache.set(id, (ok = this.q<boolean>('repos:mayReadId', { id }, p)))
      return ok
    }
  }

  canSee: Port['canSee'] = (p) => {
    const cache = new Map<string, Promise<boolean>>()
    return (full) => {
      if (!full) return !!p
      let ok = cache.get(full)
      if (!ok)
        cache.set(
          full,
          (ok = this.q<boolean>('repos:mayReadName', { full }, p)),
        )
      return ok
    }
  }

  eventVersion: Port['eventVersion'] = async () =>
    `${this.events.head}.${this.events.oldest}`

  syncVersion: Port['syncVersion'] = async (owner, name, p) => {
    const full = owner.startsWith('rep_') ? owner : `${owner}/${name}`
    return `${await this.q<string>('sync:version', { full }, p)}.${this.events.oldest}`
  }

  repoHistoryVersion: Port['repoHistoryVersion'] = async (full, p) => {
    const id = await this.repoIdForHistory(full)
    if (!id) throw apiError('not_found', `No repository ${full}.`)
    if (!(await this.canSeeId(p)(id)))
      throw apiError('not_found', `No repository ${full}.`, {
        hint: 'Check the path. Private things answer 404 to everyone who cannot see them.',
      })
    const list = this.events.repoEvents(id)
    return `${id}.${list.at(-1)?.sequence ?? 0}.${this.events.oldest}`
  }

  listEvents: Port['listEvents'] = async (p, q) => {
    const can = this.canSeeId(p)
    const canPull = !p || p.scopes.has('pulls:read')
    const canIssue = !p || p.scopes.has('issues:read')
    const types = q.type ? q.type.split(',') : null
    const typeOk = (t: string) =>
      !types ||
      types.some((x) =>
        x.endsWith('.*') ? t.startsWith(x.slice(0, -1)) : x === t,
      )
    const scopeOk = (t: string) =>
      t.startsWith('issue.')
        ? canIssue
        : /^(change|finding|check|ci|operation)\./.test(t)
          ? canPull
          : true
    const repoId = q.repo ? await this.repoIdForHistory(q.repo) : null
    const source = q.repo
      ? repoId
        ? this.events.repoEvents(repoId)
        : []
      : this.events.all()
    const allowed = new Map<string | null, boolean>()
    const hidden = new Map<string | null, Set<number>>()
    for (const e of source)
      if (!allowed.has(e.repoId)) {
        allowed.set(e.repoId, await can(e.repoId))
        if (allowed.get(e.repoId))
          hidden.set(e.repoId, await this.hiddenChanges(e.repoId, p))
      }
    const page = pageSorted(source, (e) => e.sequence, seqId, {
      limit: q.limit,
      after: q.after,
      desc: false,
      stored: 'asc',
      match: (e) =>
        typeOk(e.type) &&
        scopeOk(e.type) &&
        !!allowed.get(e.repoId) &&
        !hiddenEvent(e, hidden.get(e.repoId)),
    })
    return {
      items: page.items.map(
        (e: StoredEvent) =>
          new Pre(e.json, () => parseEvent(e), `ev${e.sequence}`),
      ),
      next: page.next,
    }
  }

  sync: Port['sync'] = async (p, q) => {
    const [owner = '', name = ''] = q.repo.split('/')
    const full = owner.startsWith('rep_') ? owner : `${owner}/${name}`
    const canPull = !p || p.scopes.has('pulls:read')
    const canIssue = !p || p.scopes.has('issues:read')
    const scopeOk = (t: string) =>
      t.startsWith('issue.')
        ? canIssue
        : /^(change|finding|check|ci|operation)\./.test(t)
          ? canPull
          : true
    const snap = await this.q<{
      id: string
      objects: Array<Record<string, unknown>>
    }>('sync:snapshot', { full, at: this.now() }, p)
    const repoId = snap.id
    const head = this.events.head
    const hidden = await this.hiddenChanges(repoId, p)
    if (hidden.size)
      snap.objects = snap.objects.filter(
        (o) => !(o.object === 'change' && hidden.has(o.number as number)),
      )
    const snapshot = (from: number, at: number, reset: boolean) => {
      const slice = snap.objects.slice(from, from + q.limit)
      const more = from + q.limit < snap.objects.length
      return {
        object: 'sync' as const,
        cursor: more
          ? `s_${repoId}_${at}_${from + q.limit}`
          : `e_${repoId}_${at}`,
        objects: slice,
        deleted: [],
        has_more: more,
        reset,
      }
    }
    const mismatch = () =>
      apiError(
        'cursor_mismatch',
        'This cursor belongs to another repository.',
        {
          errors: [
            {
              pointer: '/query/cursor',
              code: 'cursor_mismatch',
              message: 'Use a cursor returned for this repository.',
            },
          ],
        },
      )
    const c = q.cursor
    if (!c) return snapshot(0, head, true)
    const s = /^s_(.+)_(\d+)_(\d+)$/.exec(c)
    if (s) {
      if (s[1] !== repoId) throw mismatch()
      if (Number(s[2]) > head) return snapshot(0, head, true)
      return snapshot(Number(s[3]), Math.min(Number(s[2]), head), false)
    }
    const ev = /^e_(.+)_(\d+)$/.exec(c)
    if (!ev)
      throw apiError('invalid_request', 'The cursor is not valid.', {
        errors: [
          {
            pointer: '/query/cursor',
            code: 'invalid_cursor',
            message: 'Use cursor exactly as returned.',
          },
        ],
      })
    if (ev[1] !== repoId) throw mismatch()
    const after = Number(ev[2])
    if (after > head) return snapshot(0, head, true)
    if (after + 1 < this.events.oldest) return snapshot(0, head, true)
    const {
      events: stored,
      exhausted,
      scannedTo,
    } = this.events.since(
      after,
      q.limit,
      (e) =>
        e.repoId === repoId &&
        scopeOk(e.type) &&
        /^(repo|change|issue|finding|check|ci)\./.test(e.type) &&
        !hiddenEvent(e, hidden),
    )
    const latest = new Map<string, Record<string, unknown>>()
    const deleted = new Map<string, { object: string; id: string }>()
    for (const st of stored) {
      const e = parseEvent(st)
      if (e.data) {
        latest.set(e.subject.id, e.data)
        deleted.delete(e.subject.id)
      } else if (e.type.endsWith('.deleted')) {
        latest.delete(e.subject.id)
        deleted.set(e.subject.id, {
          object: e.subject.object,
          id: e.subject.id,
        })
      }
    }
    return {
      object: 'sync',
      cursor: `e_${repoId}_${exhausted ? Math.max(scannedTo, head) : scannedTo}`,
      objects: [...latest.values()],
      deleted: [...deleted.values()],
      has_more: !exhausted,
      reset: false,
    }
  }

  listNotifications: Port['listNotifications'] = (p, q) =>
    this.q('notifications:list', { ...q }, p)
  notificationsVersion: Port['notificationsVersion'] = (p) =>
    this.q('notifications:version', { access: this.accessRevision }, p)
  unreadCount: Port['unreadCount'] = (p) =>
    this.q('notifications:unreadCount', {}, p)
  markRead: Port['markRead'] = (p, id) =>
    this.m('notifications:markRead', { id }, p)
  getNotificationPrefs: Port['getNotificationPrefs'] = (p) =>
    this.q('notifications:getPrefs', {}, p)
  updateNotificationPrefs: Port['updateNotificationPrefs'] = (p, body) =>
    this.m('notifications:updatePrefs', { prefs: body }, p)

  listPipelineRuns: Port['listPipelineRuns'] = (owner, name, p, q) =>
    this.q('pipelines:list', { owner, name, ...q }, p)
  pipelinesVersion: Port['pipelinesVersion'] = (owner, name, p) =>
    this.q('pipelines:version', { owner, name }, p)
  getPipelineRun: Port['getPipelineRun'] = (owner, name, n, p) =>
    this.q('pipelines:get', { owner, name, n }, p)
  getPipelineLog: Port['getPipelineLog'] = (owner, name, n, job, step, p) =>
    this.q('pipelines:log', { owner, name, n, job, step }, p)
  rerunPipeline: Port['rerunPipeline'] = (owner, name, n, p, dry) =>
    this.m('pipelines:rerun', { owner, name, n, dry }, p)
  startPipeline: Port['startPipeline'] = async (owner, name, p, body, dry) => {
    const full = await this.repoAccess(owner, name, p, 'write')
    let sha: string | undefined
    try {
      sha = (await this.svc.git.commits(full, 1))[0]?.sha
    } catch {}
    let runsOn:
      | { jobs: Record<string, Array<string>>; warnings: Array<string> }
      | undefined
    const file = await this.q<string | null>(
      'pipelines:lastFile',
      { owner, name, workflow: body.workflow },
      p,
    )
    if (file) {
      let bytes: Uint8Array | null = null
      try {
        bytes = await this.svc.git.blob(full, file, body.branch)
      } catch {
        bytes = null
      }
      if (bytes) {
        const read = runsOnOf(new TextDecoder().decode(bytes))
        runsOn = {
          jobs: Object.fromEntries(read.jobs),
          warnings: read.warnings,
        }
      }
    }
    return this.m(
      'pipelines:start',
      { owner, name, ...body, sha, runsOn, dry },
      p,
    )
  }
  claimPipelineJob: Port['claimPipelineJob'] = (owner, name, p, body) =>
    this.m('pipelines:claim', { owner, name, runner: body.runner }, p)
  reportPipelineStep: Port['reportPipelineStep'] = (
    owner,
    name,
    n,
    job,
    step,
    p,
    body,
  ) => this.m('pipelines:report', { owner, name, n, job, step, ...body }, p)
  cancelPipeline: Port['cancelPipeline'] = (owner, name, n, p, dry) =>
    this.m('pipelines:cancel', { owner, name, n, dry }, p)
  waitPipelineStep: Port['waitPipelineStep'] = (
    owner,
    name,
    n,
    job,
    step,
    p,
    body,
    dry,
  ) => this.m('pipelines:wait', { owner, name, n, job, step, ...body, dry }, p)
  resumePipelineStep: Port['resumePipelineStep'] = (
    owner,
    name,
    n,
    job,
    step,
    p,
    body,
    dry,
  ) =>
    this.m('pipelines:resume', { owner, name, n, job, step, ...body, dry }, p)

  listAccessRules: Port['listAccessRules'] = (owner, name, p) =>
    this.q('access:list', { owner, name }, p)
  putAccessRule: Port['putAccessRule'] = (owner, name, id, p, body, dry) =>
    this.m('access:put', { owner, name, id, ...body, dry }, p)
  deleteAccessRule: Port['deleteAccessRule'] = async (
    owner,
    name,
    id,
    p,
    dry,
  ) => {
    await this.m('access:remove', { owner, name, id, dry }, p)
  }
  accessView: Port['accessView'] = (owner, name, p) =>
    this.q('access:view', { owner, name }, p)
  hiddenChanges: Port['hiddenChanges'] = async (id, p) =>
    id
      ? new Set(await this.q<Array<number>>('access:hiddenChanges', { id }, p))
      : new Set()

  getTriggers: Port['getTriggers'] = (owner, name, p) =>
    this.q('triggers:get', { owner, name }, p)
  triggersVersion: Port['triggersVersion'] = (owner, name, p) =>
    this.q('triggers:version', { owner, name }, p)

  pendingRunsOn: Port['pendingRunsOn'] = () =>
    this.q('pipelines:pendingRunsOn', {}, 'system')
  setRunsOn: Port['setRunsOn'] = async (owner, name, n, read) => {
    await this.m('pipelines:setRunsOn', { owner, name, n, read }, 'system')
  }

  createRunner: Port['createRunner'] = (p, body, dry) =>
    this.m('runners:create', { ...body, dry }, p)
  listRunners: Port['listRunners'] = (p, account) =>
    this.q('runners:list', { account, now: this.now() }, p)
  getRunner: Port['getRunner'] = (p, id) =>
    this.q('runners:get', { id, now: this.now() }, p)
  updateRunner: Port['updateRunner'] = (p, id, body, dry) =>
    this.m('runners:update', { id, ...body, dry }, p)
  deleteRunner: Port['deleteRunner'] = (p, id, dry) =>
    this.m('runners:remove', { id, dry }, p)
  runnerHeartbeat: Port['runnerHeartbeat'] = (p) =>
    this.m('runners:heartbeat', {}, p)
  runnerClaim: Port['runnerClaim'] = (p) => this.m('runners:claim', {}, p)
  runnerReport: Port['runnerReport'] = (p, body) =>
    this.m('runners:report', { ...body }, p)
  runnerWait: Port['runnerWait'] = (p, body) =>
    this.m('runners:wait', { ...body }, p)
  runnerJobs: Port['runnerJobs'] = (p, id) => this.q('runners:jobs', { id }, p)

  getPolicySet: Port['getPolicySet'] = (owner, name, p) =>
    this.q('policy:get', { owner, name, at: this.now() }, p)
  policySetVersion: Port['policySetVersion'] = (owner, name, p) =>
    this.q('policy:version', { owner, name }, p)
  createRule: Port['createRule'] = (owner, name, p, body, dry) => {
    const { name: ruleName, ...rest } = body
    return this.m(
      'policy:createRule',
      { owner, name, ruleName, ...rest, dry },
      p,
    )
  }
  deleteRule: Port['deleteRule'] = (owner, name, rule, p, dry) =>
    this.m('policy:deleteRule', { owner, name, rule, dry }, p)
  policyInFile: Port['policyInFile'] = (owner, name, p) =>
    this.q('policy:inFile', { owner, name }, p)
  proposePolicy: Port['proposePolicy'] = (owner, name, p, edits, dry) =>
    this.m('policy:propose', { owner, name, edits, dry }, p)
  landability: Port['landability'] = (owner, name, ref, p) =>
    this.q('changes:landability', { owner, name, ref, at: this.now() }, p)
  setRuleMode: Port['setRuleMode'] = (owner, name, rule, p, mode, dry) =>
    this.m('policy:setRuleMode', { owner, name, rule, mode, dry }, p)
  addPolicyException: Port['addPolicyException'] = (
    owner,
    name,
    p,
    body,
    dry,
  ) => this.m('policy:addException', { owner, name, ...body, dry }, p)
  removePolicyException: Port['removePolicyException'] = (
    owner,
    name,
    id,
    p,
    dry,
  ) => this.m('policy:removeException', { owner, name, id, dry }, p)

  listReleases: Port['listReleases'] = (owner, name, p, q) =>
    this.q('releases:list', { owner, name, ...q }, p)
  releasesVersion: Port['releasesVersion'] = (owner, name, p) =>
    this.q('releases:version', { owner, name }, p)
  getRelease: Port['getRelease'] = (owner, name, tag, p) =>
    this.q('releases:get', { owner, name, tag }, p)
  createRelease: Port['createRelease'] = async (owner, name, p, body, dry) => {
    const bad = (i: number, field: string, message: string) =>
      apiError('invalid_request', message, {
        errors: [
          { pointer: `/body/assets/${i}/${field}`, code: 'invalid', message },
        ],
      })
    await this.repoAccess(owner, name, p, 'write')
    const assets: Array<
      NonNullable<typeof body.assets>[number] & { uploadId?: string }
    > = []
    for (const [i, a] of (body.assets ?? []).entries()) {
      const { upload, ...rest } = a
      if (!upload) {
        if (a.size === undefined || a.sha256 === undefined)
          throw bad(i, 'upload', `${a.name}: give upload, or size and sha256.`)
        assets.push({ ...rest, size: a.size, sha256: a.sha256 })
        continue
      }
      const u = await this.svc.uploads.get(upload)
      if (!u || u.owner !== p!.handle)
        throw apiError('not_found', `No upload ${upload}.`)
      if (u.state !== 'uploaded' || !u.sha256)
        throw apiError('upload_incomplete', `Upload ${a.name} first.`)
      if (u.purpose !== 'release')
        throw bad(i, 'upload', `${upload} was not uploaded for a release.`)
      if (u.attachedTo) throw bad(i, 'upload', `${upload} is already attached.`)
      if (a.sha256 && a.sha256 !== u.sha256)
        throw bad(i, 'sha256', `${a.name} does not match what was uploaded.`)
      assets.push({ ...rest, size: u.size, sha256: u.sha256, uploadId: u.id })
    }
    const r = await this.m<
      Awaited<ReturnType<Port['createRelease']>> & {
        repo?: string
        repoId?: string
      }
    >('releases:create', { owner, name, ...body, assets, dry }, p)
    if (!dry && r.repo)
      for (const a of assets)
        if (a.uploadId) {
          const u = await this.svc.uploads.get(a.uploadId)
          if (u) {
            u.attachedTo = r.repo
            u.attachedRepoId = r.repoId ?? null
          }
        }
    return { release: r.release, outcome: r.outcome }
  }
  updateRelease: Port['updateRelease'] = (owner, name, tag, p, body, dry) =>
    this.m(
      'releases:update',
      { owner, name, tag, ...body, fields: Object.keys(body), dry },
      p,
    )
  downloadAsset: Port['downloadAsset'] = (owner, name, tag, asset, p) =>
    this.m('releases:download', { owner, name, tag, asset }, p)

  listConnections: Port['listConnections'] = (handle, p) =>
    this.q('integrations:listConnections', { handle }, p)
  connectionsVersion: Port['connectionsVersion'] = (handle, p) =>
    this.q('integrations:connectionsVersion', { handle }, p)
  connect: Port['connect'] = (handle, id, p, body, dry) =>
    this.m('integrations:connect', { handle, id, key: body.key, dry }, p)
  disconnect: Port['disconnect'] = (handle, id, p, dry) =>
    this.m('integrations:disconnect', { handle, id, dry }, p)
  listRepoIntegrations: Port['listRepoIntegrations'] = (owner, name, p) =>
    this.q('integrations:listRepoIntegrations', { owner, name }, p)
  repoIntegrationsVersion: Port['repoIntegrationsVersion'] = (owner, name, p) =>
    this.q('integrations:repoIntegrationsVersion', { owner, name }, p)
  setRepoIntegration: Port['setRepoIntegration'] = (
    owner,
    name,
    id,
    p,
    on,
    dry,
  ) =>
    this.m('integrations:setRepoIntegration', { owner, name, id, on, dry }, p)
  /**
   * Start the GitHub Actions workflows a push takes (.github/workflows at the
   * pushed commit), queued for a runner. Runs once per workflow and commit.
   */
  async queueWorkflows(e: {
    repo: string
    ref: string
    after: string
    actor: string
  }) {
    if (/^0+$/.test(e.after)) return []
    const storeId = await this.storeIdOf(e.repo)
    if (!storeId) return []
    const listed = await this.svc.git
      .files(e.repo, e.after)
      .catch(() => ({ paths: [] as Array<string> }))
    const files: Record<string, string> = {}
    for (const path of listed.paths.filter(isWorkflowFile).slice(0, 30)) {
      const bytes = await this.svc.git
        .blob(e.repo, path, e.after)
        .catch(() => null)
      if (bytes) files[path] = new TextDecoder().decode(bytes)
    }
    // Reusable workflows of other repositories, read from GitHub (public ones).
    for (const text of Object.values({ ...files })) {
      for (const m of text.matchAll(
        /^\s{2,}uses:\s*['"]?([\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@[\w./-]+)/gm,
      )) {
        const uses = m[1]
        if (uses in files) continue
        const at = /^([\w.-]+)\/([\w.-]+)\/(.+)@(.+)$/.exec(uses)
        if (!at) continue
        const res = await fetch(
          `https://raw.githubusercontent.com/${at[1]}/${at[2]}/${at[4]}/${at[3]}`,
        ).catch(() => null)
        if (res?.ok) files[uses] = await res.text()
      }
    }
    const planned = planPush(files, {
      ref: e.ref,
      sha: e.after,
      actor: e.actor,
    })
    if (!planned.length) return []
    const at = this.now()
    return run<Array<number>>(
      this.call,
      'mutation',
      'forge/pipelines:queuePlanned',
      {
        storeId,
        actor: e.actor,
        runs: planned.map((p) =>
          JSON.stringify(runOf(p, { number: 0, actor: e.actor, at })),
        ),
      },
      'system',
    )
  }

  /**
   * After a push to the default branch of a repository made here: its
   * languages and license, read from its files.
   */
  async detectFacts(e: {
    repo: string
    ref: string
    after: string
    by?: string
  }) {
    if (/^0+$/.test(e.after) || !e.ref.startsWith('refs/heads/')) return
    const storeId = await this.storeIdOf(e.repo)
    if (!storeId) return
    const listed = await this.svc.git.files(e.repo, e.after).catch(() => null)
    if (!listed) return
    const top = listed.paths.filter((p) => !p.includes('/'))
    const licensePath = top.find((p) => LICENSE_FILES.test(p))
    const text = licensePath
      ? await this.svc.git
          .blob(e.repo, licensePath, e.after)
          .then((b) => (b ? new TextDecoder().decode(b) : null))
          .catch(() => null)
      : null
    await run(
      this.call,
      'mutation',
      'forge/providers:setDetected',
      {
        storeId,
        ref: e.ref,
        languages: languagesOf(listed.paths.map((path) => ({ path }))),
        license: text ? licenseOf(text) : null,
      },
      'system',
    )
    // The policy and triggers the branch now has (applied on the default
    // branch only; the mutation checks).
    const read = (path: string) =>
      this.svc.git
        .blob(e.repo, path, e.after)
        .then((b) => (b ? new TextDecoder().decode(b) : null))
        .catch(() => null)
    const triggerPaths = listed.paths.filter(isTriggerFile)
    const [policy, ...triggers] = await Promise.all([
      listed.paths.includes(POLICY_FILE) ? read(POLICY_FILE) : null,
      ...triggerPaths.map(read),
    ])
    await run(
      this.call,
      'mutation',
      'forge/sourceFiles:fromGit',
      {
        storeId,
        ref: e.ref,
        sha: e.after,
        ...(e.by ? { by: e.by } : {}),
        policy,
        triggers: triggerPaths.flatMap((path, i) =>
          typeof triggers[i] === 'string' ? [{ path, text: triggers[i] }] : [],
        ),
      },
      'system',
    )
  }

  private agentOnline(account: string, label: string) {
    return this.q<boolean>(
      'runners:hasLabel',
      { account, label },
      'system',
    ).catch(() => false)
  }

  private async queueAgent(full: string, plan: Planned, actor: string) {
    const storeId = await this.storeIdOf(full)
    if (!storeId) return []
    return run<Array<number>>(
      this.call,
      'mutation',
      'forge/pipelines:queuePlanned',
      {
        storeId,
        actor,
        runs: [
          JSON.stringify(runOf(plan, { number: 0, actor, at: this.now() })),
        ],
      },
      'system',
    )
  }

  /**
   * The Hand off button: a job for the person's own agent (a runner labelled
   * t3, started once with cb runner start), which opens the T3 Code thread.
   * Nothing to copy. The same subject on the same commit is queued once.
   */
  async startHandoff(
    owner: string,
    name: string,
    p: Principal,
    subject: string,
  ) {
    const full = await this.repoAccess(owner, name, p, 'write')
    const run_ = /^run:(\d+)$/.exec(subject)
    let title = subject
    if (run_)
      title = (
        await this.q<{ title: string }>(
          'pipelines:get',
          { owner, name, n: Number(run_[1]) },
          p,
        ).catch(() => ({ title: subject }))
      ).title
    else {
      const n = Number(subject.replace(/^#/, ''))
      const issue = await this.q<{ title: string } | null>(
        'issues:get',
        { owner, name, number: n },
        p,
      ).catch(() => null)
      const change = issue
        ? null
        : await this.q<{ title: string }>(
            'changes:get',
            { owner, name, ref: String(n), expand: [], at: this.now() },
            p,
          ).catch(() => null)
      if (!issue && !change)
        throw apiError(
          'not_found',
          `#${n} is not an issue or change in ${full}.`,
        )
      title = (issue ?? change)!.title
    }
    const repo = await this.q<{ default_branch: string }>(
      'repos:get',
      { owner, name, at: this.now() },
      p,
    )
    const sha =
      (await this.svc.git.commits(full, 1).catch(() => []))[0]?.sha ?? ''
    const runs = await this.queueAgent(
      full,
      handoffPlan({
        subject: subject.replace(/^#/, ''),
        title,
        branch: repo.default_branch,
        sha,
      }),
      p.handle,
    )
    return {
      run: runs[0] ?? null,
      agent: await this.agentOnline(owner, 't3'),
    }
  }

  /**
   * After a change is opened or gets a patch set: an AI review, when the
   * account has a runner labelled reviewer to take it.
   */
  async queueReview(e: { repo: string; number: number }) {
    const [owner, name] = e.repo.split('/')
    if (!(await this.agentOnline(owner, 'reviewer'))) return []
    const c = await this.q<{
      number: number
      title: string
      branch: string
      state: string
      head: { patch_set: number; sha: string }
    }>(
      'changes:get',
      { owner, name, ref: String(e.number), expand: [], at: this.now() },
      'system',
    ).catch(() => null)
    if (!c || (c.state !== 'open' && c.state !== 'draft')) return []
    return this.queueAgent(
      e.repo,
      reviewPlan({
        change: c.number,
        patchSet: c.head.patch_set,
        title: c.title,
        branch: c.branch,
        sha: c.head.sha,
      }),
      'cobalt',
    )
  }

  /**
   * A landed change's code on its base branch: the change's branch merged in
   * the store at the commit that was checked, with the repository's landing
   * strategy, as whoever landed it. Then it counts as a push to the base, so
   * the workflows it takes start. A repository linked to a host lands there.
   */
  async landInGit(e: { repo: string; number: number; by: string }) {
    const [owner, name] = e.repo.split('/')
    if (!this.svc.git.merge) return null
    const link = await this.svc.providers?.store
      .remoteOfRepo(e.repo)
      .catch(() => null)
    if (link) return null
    const c = await this.q<{
      number: number
      title: string
      branch: string
      base: string
      state: string
      head: { sha: string }
      policy?: { landing?: { strategy?: 'squash' | 'merge' | 'rebase' } }
    }>(
      'changes:get',
      { owner, name, ref: String(e.number), expand: [], at: this.now() },
      'system',
    )
    if (c.state !== 'landed') return null
    const r = await this.svc.git.merge(e.repo, {
      source: c.branch,
      sha: c.head.sha,
      target: c.base,
      strategy: c.policy?.landing?.strategy ?? 'squash',
      author: { name: e.by, email: `${e.by}@users.cobaltforge.dev` },
      message: `${c.title} (#${c.number})\n\nLanded-by: ${e.by}`,
    })
    const storeId = await this.storeIdOf(e.repo)
    if (storeId && r.before !== r.sha)
      await this.recordPushes({ full: e.repo, storeId, by: e.by }, [
        {
          ref: `refs/heads/${c.base}`,
          before: r.before ?? '0'.repeat(40),
          after: r.sha,
        },
      ])
    return r
  }

  /** Pushes that went through the API's git endpoint, with their messages. */
  async recordPushes(
    at: { full: string; storeId: string; by?: string },
    updates: ReadonlyArray<{ ref: string; before: string; after: string }>,
  ) {
    for (const u of updates) {
      const deleted = /^0+$/.test(u.after)
      const message = deleted
        ? undefined
        : await this.svc.git
            .commit(at.full, u.after)
            .then((c) => c.message.slice(0, 65536))
            .catch(() => undefined)
      // A push to a change's branch is its next patch set: its files, from git.
      const branch = u.ref.startsWith('refs/heads/')
        ? u.ref.slice('refs/heads/'.length)
        : null
      const base =
        deleted || !branch
          ? null
          : await run<string | null>(
              this.call,
              'query',
              'forge/pushes:baseOfBranch',
              { storeId: at.storeId, branch },
              'system',
            ).catch(() => null)
      const stats = base
        ? await this.svc.git
            .diff(at.full, u.after, base)
            .then((d) => statsOf(d.files))
            .catch(() => undefined)
        : undefined
      await run(
        this.call,
        'mutation',
        'forge/pushes:recordPushFromApi',
        {
          storeId: at.storeId,
          ref: u.ref,
          before: u.before,
          after: u.after,
          pushedAt: this.now(),
          ...(at.by ? { by: at.by } : {}),
          ...(message === undefined ? {} : { message }),
          ...(stats ? { stats } : {}),
        },
        'system',
      )
    }
  }

  handlesOfLogins: Port['handlesOfLogins'] = (host, logins) =>
    logins.length
      ? this.q(
          'integrations:handlesOfLogins',
          { host, logins: [...logins] },
          'system',
        )
      : Promise.resolve({})
  listLinks: Port['listLinks'] = (handle, p) =>
    this.q('integrations:listLinks', { handle }, p)
  linkAccount: Port['linkAccount'] = (handle, host, p, body) =>
    this.m('integrations:link', { handle, host, ...body }, p)
  unlinkAccount: Port['unlinkAccount'] = (handle, host, p, login) =>
    this.m(
      'integrations:unlink',
      { handle, host, ...(login ? { login } : {}) },
      p,
    )
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

  private providersFor(host: string) {
    const sync = this.svc.providers
    if (host === 'gitea' || !sync?.configured(host as ProviderId))
      throw apiError(
        'invalid_request',
        `Importing from ${host} is not supported here: ${host === 'gitea' ? 'self-hosted servers are not linked yet' : `${host} is not set up on this server`}.`,
      )
    return sync
  }

  importRepo: Port['importRepo'] = async (p, body, dry) => {
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
      return { repo: await this.getRepo(ho, hn, p), created: false }
    }
    if (dry)
      return this.createRepoWith(
        p,
        {
          owner: body.owner,
          name,
          visibility: body.visibility,
          description: pr.remote.description.trim().slice(0, 500),
        },
        true,
        sync.link(pr),
      )
    const made = await this.importPrepared(p, pr, {
      owner: body.owner ?? p.handle,
      name,
      visibility: body.visibility,
    })
    const [o, n] = made.full.split('/')
    return { repo: await this.getRepo(o, n, p), created: made.created }
  }

  async importPrepared(
    p: Principal,
    pr: Prepared,
    o: { owner: string; name: string; visibility: 'public' | 'private' },
  ) {
    const sync = this.svc.providers!
    const made = await this.createRepoWith(
      p,
      {
        owner: o.owner,
        name: o.name,
        visibility: o.visibility,
        description: pr.remote.description.trim().slice(0, 500),
      },
      false,
      sync.link(pr),
    )
    if (!made.created)
      throw apiError(
        'invalid_state',
        `${made.repo.full_name} already exists and is not linked to ${labelOf(pr.provider)}.`,
        { hint: 'Pick another name with `name`.' },
      )
    try {
      await sync.linked(p, made.repo.full_name, pr)
    } catch (e) {
      await this.deleteRepo(
        made.repo.owner,
        made.repo.name,
        p,
        made.repo.full_name,
        false,
      ).catch(() => undefined)
      throw e
    }
    await this.m<Awaited<ReturnType<Port['getRepo']>>>(
      'integrations:markImported',
      {
        owner: made.repo.owner,
        name: made.repo.name,
        host: pr.provider,
        slug: pr.remote.slug,
        at: this.now(),
        defaultBranch: pr.remote.defaultBranch,
      },
      p,
    )
    const x = await this.svc.extras.open(made.repo.full_name)
    x.mirrors.push({
      id: `mir_${this.now().toString(36)}0`.padEnd(22, '0').slice(0, 22),
      host: pr.provider,
      slug: pr.remote.slug,
      direction: 'two-way',
      state: 'syncing',
      lastSync: this.now(),
      detail: `The first sync from ${labelOf(pr.provider)} is running.`,
      created: this.now(),
    })
    await this.svc.extras.flush?.()
    return { full: made.repo.full_name, created: true }
  }

  providerHost(): SyncHost {
    return {
      requireAdmin: async (p, full) => {
        const [o, n] = full.split('/')
        await this.q('providers:requireAdmin', { owner: o, name: n }, p)
      },
      unlink: (full) =>
        scoped(async () => {
          await this.m('integrations:unlinkGithub', { full }, 'system').catch(
            () => undefined,
          )
          const x = await this.svc.extras.open(full)
          x.mirrors.splice(0, x.mirrors.length)
          await this.svc.extras.flush?.()
        }),
      mirror: (full, state, detail) =>
        scoped(async () => {
          const x = await this.svc.extras.open(full)
          let m = x.mirrors.at(0)
          if (!m) {
            const link = await this.svc.providers?.store.remoteOfRepo(full)
            if (!link) return
            m = {
              id: `mir_${this.now().toString(36)}0`
                .padEnd(22, '0')
                .slice(0, 22),
              host: link.provider,
              slug: link.fullName,
              direction: 'two-way',
              state,
              lastSync: this.now(),
              detail,
              created: link.at,
            }
            x.mirrors.push(m)
          }
          m.state = state
          m.detail = detail
          if (state === 'in-sync') m.lastSync = this.now()
          await this.svc.extras.flush?.()
        }),
      importOne: (p, pr, o) => scoped(() => this.importPrepared(p, pr, o)),
      setLanguages: async (full, languages) => {
        await this.m(
          'providers:setLanguages',
          { repo: full, languages },
          'system',
        )
      },
      setAbout: async (full, about, was) => {
        await this.m('providers:setAbout', { repo: full, about, was }, 'system')
      },
      hasCommit: (full, sha) =>
        this.svc.git.commit(full, sha).then(
          () => true,
          () => false,
        ),
      materialize: async (full, item) => {
        if (item.kind === 'secrets') {
          const names = item.names
          return scoped(async () => {
            const x = await this.svc.extras.open(full)
            const added = declareSecrets(x.env, item.host, names)
            if (added) await this.svc.extras.flush?.()
            return `${added} declared`
          })
        }
        const { kind, ...rest } = item
        const fn =
          kind === 'pull'
            ? 'changes:importPull'
            : kind === 'checks'
              ? 'changes:importChecks'
              : kind === 'issue'
                ? 'issues:importIssue'
                : kind === 'labels'
                  ? 'issues:importLabels'
                  : 'releases:importRelease'
        return this.m<string>(fn, { repo: full, ...rest }, 'system')
      },
    }
  }

  githubDeviceStart: Port['githubDeviceStart'] = () =>
    deviceStart(this.svc.github)

  githubDevicePoll: Port['githubDevicePoll'] = async (p, deviceCode) => {
    const r = await devicePoll(this.svc.github, p, deviceCode, (login, t) =>
      this.keepGithub(p.handle, login, t),
    )
    if (r.status === 'authorized' && r.login)
      await this.m(
        'integrations:markVerified',
        { handle: p.handle, login: r.login },
        'system',
      )
    return r
  }

  private async keepGithub(
    handle: string,
    login: string,
    tokens: {
      access: string
      refresh: string | null
      expiresAt: number | null
    },
  ) {
    await this.svc.providers
      ?.rememberGithub(handle, login, tokens)
      .catch((e: unknown) =>
        console.error('[github] could not keep the sign-in', String(e)),
      )
  }

  githubOauthStart: Port['githubOauthStart'] = (p, redirectUri, returnTo) =>
    oauthStart(this.svc.github, p, redirectUri, returnTo)

  githubOauthFinish: Port['githubOauthFinish'] = async (p, body) => {
    const r = await oauthFinish(this.svc.github, p, body, (login, t) =>
      this.keepGithub(p.handle, login, t),
    )
    await this.m(
      'integrations:markVerified',
      { handle: p.handle, login: r.login },
      'system',
    )
    return r
  }

  githubRepos: Port['githubRepos'] = async (p, access) => {
    const refs = await needGithub(this.svc.github).repos(access, p.handle)
    const held =
      refs.length && this.svc.providers
        ? await this.svc.providers.store.claims(
            'github',
            'github.com',
            refs.map((r) => String(r.id)),
          )
        : {}
    return refs.map((r) => presentGithubRepo(r, held[String(r.id)] ?? null))
  }

  async storeIdOf(full: string) {
    return (
      this.svc.git.storeOf?.(full) ??
      (await this.q<string | null>('repos:storeIdOf', { full }, 'system'))
    )
  }

  private async mirrorOf(
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
  ) {
    const full = await this.repoAccess(owner, name, p, 'write')
    const x = await this.svc.extras.open(full)
    const m = x.mirrors.find((r) => r.id === mirror)
    if (!m) throw apiError('not_found', `No mirror ${mirror}.`)
    return { full, x, m }
  }

  createMirror: Port['createMirror'] = async (p, owner, name, body, dry) => {
    if (body.host !== 'github')
      throw apiError(
        'invalid_request',
        `Mirrors on ${body.host} are not supported: only GitHub repositories can be linked.`,
      )
    const full = await this.repoAccess(owner, name, p, 'write')
    const same = (await this.svc.extras.open(full)).mirrors.find(
      (m) =>
        m.host === body.host &&
        m.slug.toLowerCase() === body.slug.toLowerCase(),
    )
    if (same)
      return {
        mirror: presentMirror(this.urls.api, full, same),
        created: false,
      }
    if (!body.github_access)
      throw apiError(
        'invalid_request',
        'Linking a repository to GitHub needs `github_access`.',
        {
          hint: 'Sign in with GitHub first: POST /github/device, then poll /github/device/poll.',
        },
      )
    const sync = this.providersFor('github')
    const [o, n] = full.split('/')
    const repo = await this.q<{
      visibility: string
      description: string
      default_branch: string
    }>('repos:get', { owner: o, name: n, at: this.now() }, p)
    const storeId = await this.storeIdOf(full)
    if (!storeId) throw apiError('not_found', `${full} has no git storage.`)
    if (dry)
      return {
        mirror: presentMirror(this.urls.api, full, {
          id: 'mir_dry_run_00000000000',
          host: 'github',
          slug: body.slug,
          direction: 'two-way',
          state: 'syncing',
          lastSync: this.now(),
          detail: null,
          created: this.now(),
        }),
        created: true,
      }
    const x = await this.svc.extras.open(full)
    const m = {
      id: `mir_${this.now().toString(36)}0`.padEnd(22, '0').slice(0, 22),
      host: 'github',
      slug: body.slug,
      direction: 'two-way' as const,
      state: 'syncing' as 'syncing' | 'failing' | 'in-sync',
      lastSync: this.now(),
      detail: `Sending the history to ${body.slug} on GitHub.` as string | null,
      created: this.now(),
    }
    x.mirrors.push(m)
    await this.svc.extras.flush?.()
    // Copying the history and linking outlast a request: the mirror says how
    // it went, as an import's job does.
    const settle = async (patch: Partial<typeof m>) =>
      scoped(async () => {
        const y = await this.svc.extras.open(full)
        const mine = y.mirrors.find((z) => z.id === m.id)
        if (!mine) return
        Object.assign(mine, patch, { lastSync: this.now() })
        await this.svc.extras.flush?.()
      })
    void sync
      .publish(p, full, {
        storeId,
        slug: body.slug,
        githubAccess: body.github_access,
        private: repo.visibility !== 'public',
        description: repo.description,
        defaultBranch: repo.default_branch,
        sendHistory: async (target) => {
          const source = await codeStorageRemotes().open(storeId, {
            write: false,
            subject: p.handle,
          })
          await copyHistory(source, target, {
            first: `refs/heads/${repo.default_branch}`,
          })
        },
      })
      .then((done) =>
        settle({
          slug: done.slug,
          detail: done.made
            ? `Made ${done.slug} on GitHub and sent it the history.`
            : `Sent the history to ${done.slug} on GitHub and linked it.`,
        }),
      )
      .catch((e: unknown) =>
        settle({
          state: 'failing',
          detail: e instanceof ApiError ? e.detail : String(e),
        }),
      )
    return { mirror: presentMirror(this.urls.api, full, m), created: true }
  }

  syncMirror: Port['syncMirror'] = async (p, owner, name, mirror, dry) => {
    const { full, x, m } = await this.mirrorOf(p, owner, name, mirror)
    if (!dry) {
      const remote = await this.svc.providers?.store.remoteOfRepo(full)
      const store = await this.storeIdOf(full)
      try {
        if (remote) await this.svc.providers!.pull(remote)
        else if (store) await this.svc.git.pull?.(store)
      } catch (e) {
        if ((e as { code?: string }).code !== 'sync_in_progress')
          throw upstreamProblem(e, remote?.provider)
      }
      m.state = 'syncing'
      m.detail = null
      await this.svc.extras.flush?.()
      void x
    }
    return presentMirror(this.urls.api, full, { ...m, state: 'syncing' })
  }

  updateMirror: Port['updateMirror'] = async (p, owner, name, mirror, body) => {
    const { full, m } = await this.mirrorOf(p, owner, name, mirror)
    if (body.paused)
      throw apiError('invalid_request', 'A GitHub link cannot be paused.', {
        hint: 'Delete the mirror to unlink the repository.',
      })
    if (body.direction && body.direction !== 'two-way')
      throw apiError(
        'invalid_request',
        'A GitHub link always goes both ways.',
        { hint: 'Delete the mirror to unlink the repository.' },
      )
    return presentMirror(this.urls.api, full, m)
  }

  deleteMirror: Port['deleteMirror'] = async (p, owner, name, mirror, dry) => {
    const { full, x, m } = await this.mirrorOf(p, owner, name, mirror)
    if (dry) return
    if (await this.svc.providers?.unlinkRepo(p, full)) return
    const store = await this.storeIdOf(full)
    if (store)
      try {
        await this.svc.git.detach?.(store)
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw upstreamProblem(e)
      }
    await this.m('integrations:unlinkGithub', { full }, 'system')
    x.mirrors.splice(x.mirrors.indexOf(m), 1)
    await this.svc.extras.flush?.()
  }

  listImports: Port['listImports'] = async (p) => {
    const found = await this.q<
      Array<{ repo: string; host: string; slug: string; created: number }>
    >('integrations:listImports', {}, p)
    const shown = []
    for (const r of found) {
      const m = (await this.svc.extras.open(r.repo)).mirrors.find(
        (x) => x.host === r.host && x.slug === r.slug,
      )
      const warnings = (await this.svc.providers?.warningsFor(r.repo)) ?? []
      shown.push({ r, m, warnings })
    }
    return shown
      .map(({ r, m, warnings }) => {
        return {
          object: 'import' as const,
          repo: r.repo,
          host: r.host as 'github' | 'gitlab' | 'codeberg',
          slug: r.slug,
          state: m?.state ?? ('in-sync' as const),
          created_at: new Date(r.created).toISOString(),
          warnings,
        }
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  getAccountPrefs: Port['getAccountPrefs'] = (p) =>
    this.q('people:getPrefs', {}, p)
  updateAccountPrefs: Port['updateAccountPrefs'] = (p, body) =>
    this.reindex(
      this.m('people:updatePrefs', { body: JSON.stringify(body) }, p),
      false,
    )
  follow: Port['follow'] = (p, handle, on) =>
    this.m('people:follow', { handle, on }, p)
  listFollows: Port['listFollows'] = (handle, which, q) =>
    this.q('people:listFollows', { handle, which, ...q }, null)
  peopleVersion: Port['peopleVersion'] = (p) =>
    this.q('people:peopleVersion', { access: this.accessRevision }, p)
  listPeople: Port['listPeople'] = (p, q) =>
    this.q('people:listPeople', { ...q }, p)
  profileVersion: Port['profileVersion'] = (handle, p) =>
    this.q(
      'people:profileVersion',
      { handle, at: this.now(), access: this.accessRevision },
      p,
    )
  profile: Port['profile'] = async (handle, p) => {
    const since = this.now() - 365 * 86_400_000
    const repos = await this.q<Array<string>>(
      'people:profileRepos',
      { handle, since },
      p,
    )
    const email = `${handle}@users.cobaltforge.dev`
    const pushes: Array<{ repo: string; at: number; title: string }> = []
    for (const full of repos) {
      let commits: Awaited<ReturnType<Attached['git']['commits']>> = []
      try {
        commits = await this.svc.git.commits(full, 1000)
      } catch {
        commits = []
      }
      for (const c of commits) {
        const at = Date.parse(c.date)
        if (at >= since && c.author.email.toLowerCase() === email)
          pushes.push({ repo: full, at, title: c.message.split('\n')[0] })
      }
    }
    return this.q('people:profile', { handle, at: this.now(), pushes }, p)
  }

  private async history(full: string, limit: number) {
    try {
      return await this.svc.git.commits(full, limit)
    } catch {
      return []
    }
  }

  private downloadsOf(
    d: { total: number; days: Array<{ day: number; n: number }> },
    now: number,
  ) {
    const days = Array.from({ length: 60 }, () => 0)
    const end = Math.floor(now / 86_400_000)
    for (const x of d.days) {
      const k = 59 - (end - x.day)
      if (k >= 0 && k < 60) days[k] += x.n
    }
    const sum = (xs: Array<number>) => xs.reduce((a, b) => a + b, 0)
    const last = sum(days.slice(30))
    const before = sum(days.slice(0, 30))
    return {
      total: d.total,
      daily: days.slice(30),
      change: before ? Math.round(((last - before) / before) * 100) : null,
    }
  }

  repoInsights: Port['repoInsights'] = async (owner, name, p) => {
    const full = await this.repoAccess(owner, name, p, 'read')
    const now = this.now()
    const commits = await this.history(full, 1000)
    const f = await this.q<{
      repo: string
      byModel: Array<{ model: string | null; count: number }>
      downloads: { total: number; days: Array<{ day: number; n: number }> }
      stars: { total: number; today: number }
      issues: Partial<Record<string, number>>
      changes: Partial<Record<string, number>>
    }>('insights:repoFacts', { owner, name, at: now }, p)
    const WEEKS = 26
    const weeks = Array.from({ length: WEEKS }, () => 0)
    for (const c of commits) {
      const w = Math.floor((now - Date.parse(c.date)) / (7 * 86_400_000))
      if (w >= 0 && w < WEEKS) weeks[WEEKS - 1 - w]++
    }
    return {
      object: 'repo_insights' as const,
      repo: f.repo,
      commits: { total: commits.length, by_week: weeks, by_model: f.byModel },
      contributors: groupAuthors(
        commits.map((c) => ({ ...c.author, date: c.date })),
      ).length,
      downloads: this.downloadsOf(f.downloads, now),
      stars: f.stars,
      issues: { open: f.issues.open ?? 0, closed: f.issues.closed ?? 0 },
      changes: {
        open: (f.changes.open ?? 0) + (f.changes.draft ?? 0),
        landed: f.changes.landed ?? 0,
        abandoned: f.changes.abandoned ?? 0,
      },
    }
  }
  insightsVersion: Port['insightsVersion'] = (owner, name, p) =>
    this.q(
      'insights:repoVersion',
      { owner, name, at: this.now(), access: this.accessRevision },
      p,
    )

  private failingMirrors(
    repos: Array<string>,
    mirrorsOf: Map<string, Array<MirrorRec>>,
  ) {
    return repos.flatMap((repo) =>
      (mirrorsOf.get(repo) ?? [])
        .filter((m) => m.state === 'failing')
        .map((m) => ({
          repo,
          host: m.host,
          detail: m.detail ?? null,
          lastSync: m.lastSync,
        })),
    )
  }

  inbox: Port['inbox'] = async (p, limit) => {
    if (!p) throw apiError('unauthenticated', 'Sign in to see your inbox.')
    const f = await this.q<
      Omit<NeedsFacts, 'mirrors'> & { owned: Array<string> }
    >('inbox:facts', { at: this.now() }, p)
    const mirrorsOf = new Map<string, Array<MirrorRec>>()
    for (const repo of f.owned)
      mirrorsOf.set(repo, (await this.svc.extras.open(repo)).mirrors)
    return presentInbox(
      needsFrom({ ...f, mirrors: this.failingMirrors(f.owned, mirrorsOf) }),
      Math.min(limit, INBOX_MAX),
    )
  }

  dashboard: Port['dashboard'] = async (p, as) => {
    if (!p) throw apiError('unauthenticated', 'Sign in to see your dashboard.')
    const now = this.now()
    const me = p.handle
    type Run = {
      number: number
      workflow: string
      title: string
      branch: string
      status: string
      actor: string
      started: number
    }
    const f = await this.q<{
      account: string
      storageLimit: number
      unlimited: boolean
      owned: Array<{
        repo: string
        id: string
        updated: number
        upstream: boolean
        stars: number
        starsToday: number
        openChanges: number
        openIssues: number
        size: number
        runs: Array<Run>
        agentChanges: Array<{
          number: number
          title: string
          state: string
          author: string
          patchSets: number
          via: {
            machine: string | null
            tool: string | null
            model: string | null
          } | null
        }>
      }>
      toReview: Array<{
        repo: string
        number: number
        title: string
        author: string
        updated: number
      }>
      assigned: Array<{
        repo: string
        number: number
        title: string
        updated: number
      }>
      reviewTimes: Array<number>
      openedTimes: Array<number>
      downloads: { total: number; days: Array<{ day: number; n: number }> }
    }>('insights:dashboardFacts', { account: as, at: now }, p)
    const ago = (t: number) => new Date(t).toISOString()
    const path = (full: string, tail = '') => `/${full}${tail}`
    const mainOf = (runs: Array<Run>) =>
      runs.find(
        (x) =>
          x.branch === 'main' &&
          x.status !== 'queued' &&
          x.status !== 'running' &&
          x.status !== 'waiting',
      )
    const mirrorsOf = new Map<string, Array<MirrorRec>>()
    for (const r of f.owned)
      mirrorsOf.set(r.repo, (await this.svc.extras.open(r.repo)).mirrors)
    const needs = dashboardNeeds(
      needsFrom({
        mirrors: this.failingMirrors(
          f.owned.map((r) => r.repo),
          mirrorsOf,
        ),
        mainFailures: f.owned.flatMap((r) => {
          const main = mainOf(r.runs)
          return main?.status === 'failure'
            ? [
                {
                  repo: r.repo,
                  number: main.number,
                  workflow: main.workflow,
                  title: main.title,
                  started: main.started,
                },
              ]
            : []
        }),
        toReview: f.toReview,
        assigned: f.assigned,
      }),
    )
    const progress: Awaited<ReturnType<Port['dashboard']>>['in_progress'] = []
    for (const r of f.owned) {
      for (const c of r.agentChanges)
        progress.push({
          kind: 'agent',
          title: c.title,
          repo: `${r.repo} · #${c.number}`,
          status: c.state === 'draft' ? 'Draft' : 'Waiting on review',
          detail: `${c.author} via ${c.via?.tool ?? 'a tool'} · ${c.via?.model}, patch set ${c.patchSets}`,
          path: path(r.repo, `/changes?n=${c.number}`),
        })
      for (const x of r.runs)
        if (x.status === 'running' || x.status === 'queued')
          progress.push({
            kind: 'change',
            title: x.title,
            repo: `${r.repo} · ${x.workflow} #${x.number}`,
            status: x.status === 'running' ? 'Running' : 'Queued',
            detail: `${x.branch} by ${x.actor}`,
            path: path(r.repo, `/pipelines?n=${x.number}`),
          })
    }
    const activity = f.owned
      .flatMap((r) => this.events.repoEvents(r.id).slice(-30))
      .map((x) => parseEvent(x))
      .filter((e) => e.actor.handle !== me)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, 30)
      .map((e) => ({
        who: e.actor.handle,
        via: e.via ?? null,
        type: e.type,
        repo: e.repo,
        subject: e.subject.number,
        at: e.created_at,
      }))
    const mirrors = new Map<
      string,
      { host: string; state: 'synced' | 'stopped'; repos: number }
    >()
    for (const r of f.owned)
      for (const m of mirrorsOf.get(r.repo) ?? []) {
        const have = mirrors.get(m.host) ?? {
          host: m.host,
          state: 'synced' as const,
          repos: 0,
        }
        mirrors.set(m.host, {
          host: m.host,
          state: m.state === 'failing' ? 'stopped' : have.state,
          repos: have.repos + 1,
        })
      }
    const commitTimes: Array<number> = []
    for (const r of f.owned)
      for (const c of await this.history(r.repo, 300))
        if (c.author.email.toLowerCase() === `${me}@users.cobaltforge.dev`)
          commitTimes.push(Date.parse(c.date))
    const bucket = (times: Array<number>) => {
      const days = Array.from({ length: 56 }, () => 0)
      const end = Math.floor(now / 86_400_000)
      for (const t of times) {
        const k = 55 - (end - Math.floor(t / 86_400_000))
        if (k >= 0 && k < 56) days[k]++
      }
      return days
    }
    const daily = [commitTimes, f.reviewTimes, f.openedTimes].map(bucket)
    const sum = (xs: Array<number>) => xs.reduce((a, b) => a + b, 0)
    const total = (k: number) => sum(daily[k].slice(28))
    const before = sum(daily.flatMap((d) => d.slice(0, 28)))
    const all = total(0) + total(1) + total(2)
    return {
      object: 'dashboard' as const,
      account: f.account,
      empty: f.owned.length === 0,
      needs_you: needs.slice(0, 20),
      in_progress: progress.slice(0, 20),
      activity,
      repos: [...f.owned]
        .sort((a, b) => b.updated - a.updated)
        .map((r) => ({
          repo: r.repo,
          checks:
            mainOf(r.runs)?.status === 'failure'
              ? ('failing' as const)
              : ('passing' as const),
          open_changes: r.openChanges,
          open_issues: r.openIssues,
          updated_at: ago(r.updated),
        })),
      mirrors: [...mirrors.values()],
      storage: {
        used_bytes: f.owned.reduce((n, r) => n + r.size, 0),
        limit_bytes: f.storageLimit,
        unlimited: f.unlimited,
      },
      imported: f.owned.filter((r) => r.upstream).length,
      downloads: this.downloadsOf(f.downloads, now),
      contributions: {
        daily: daily[0]
          .slice(28)
          .map((n, i) => n + daily[1][28 + i] + daily[2][28 + i]),
        total: all,
        change: before ? Math.round(((all - before) / before) * 100) : null,
        commits: total(0),
        reviews: total(1),
        changes: total(2),
      },
      stars: {
        total: f.owned.reduce((n, r) => n + r.stars, 0),
        today: f.owned.reduce((n, r) => n + r.starsToday, 0),
      },
    }
  }

  flushHealth = async () => {
    const h = this.svc.health
    if (!h) return
    const buckets = h.drain()
    if (!buckets.length) return
    try {
      await this.m('health:record', { buckets }, 'system')
    } catch (e) {
      h.restore(buckets)
      throw e
    }
  }

  private async sharedHealth(): Promise<HealthReader> {
    await this.flushHealth().catch((e: unknown) =>
      console.error('[api] could not share health', e),
    )
    const r = await this.q<{
      areas: Partial<
        Record<
          string,
          {
            days: Array<{ day: number; requests: number; errors: number }>
            minutes: Array<{
              minute: number
              requests: number
              errors: number
              hist: Array<number>
            }>
          }
        >
      >
    }>('health:report', { areas: [...healthAreas] }, 'system')
    const at = this.now()
    const first = Math.min(
      ...Object.values(r.areas).flatMap((a) => a?.days.map((d) => d.day) ?? []),
    )
    return {
      since: Number.isFinite(first)
        ? first * 86_400_000
        : (this.svc.health?.since ?? at),
      report: (area) =>
        reportFrom(at, r.areas[area]?.days ?? [], r.areas[area]?.minutes ?? []),
    }
  }

  status: Port['status'] = async () => {
    const health = await this.sharedHealth()
    const f = await this.q<{
      waiting: number
      oldest: number | null
      counts: {
        accounts: number
        repositories: number
        changes: number
        issues: number
      }
    }>('insights:statusFacts', {}, 'system')
    const mirrors: Array<{
      repo: string
      host: string
      state: string
      paused?: boolean
    }> = []
    for (const { repo, mirror: m } of await this.svc.extras.allMirrors())
      mirrors.push({ repo, host: m.host, state: m.state, paused: m.paused })
    return statusReport({
      now: this.now(),
      health,
      mirrors,
      waiting: f.waiting,
      oldest: f.oldest,
      counts: f.counts,
    })
  }

  listTeams: Port['listTeams'] = (org, p) => this.q('teams:list', { org }, p)
  getTeam: Port['getTeam'] = (org, slug, p) =>
    this.q('teams:get', { org, slug }, p)
  teamVersion: Port['teamVersion'] = (org, slug, p) =>
    this.q('teams:version', { org, slug }, p)
  createTeam: Port['createTeam'] = (org, p, input, dry) =>
    this.m('teams:create', { org, ...input, dry }, p)
  updateTeam: Port['updateTeam'] = (org, slug, p, body, ifMatch, dry) =>
    this.m('teams:update', { org, slug, ...body, ifMatch, dry }, p)
  deleteTeam: Port['deleteTeam'] = (org, slug, p, dry) =>
    this.reindex(this.m('teams:remove', { org, slug, dry }, p), dry)
  setTeamMember: Port['setTeamMember'] = (org, slug, login, p, dry) =>
    this.reindex(this.m('teams:setMember', { org, slug, login, dry }, p), dry)
  removeTeamMember: Port['removeTeamMember'] = (org, slug, login, p, dry) =>
    this.reindex(
      this.m('teams:removeMember', { org, slug, login, dry }, p),
      dry,
    )
  setTeamRepo: Port['setTeamRepo'] = (
    org,
    slug,
    owner,
    name,
    permission,
    p,
    dry,
  ) =>
    this.reindex(
      this.m('teams:setRepo', { org, slug, owner, name, permission, dry }, p),
      dry,
    )
  removeTeamRepo: Port['removeTeamRepo'] = (org, slug, owner, name, p, dry) =>
    this.reindex(
      this.m('teams:removeRepo', { org, slug, owner, name, dry }, p),
      dry,
    )
}

const statsOf = (
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
) =>
  files.slice(0, 1000).map((f) => ({
    path: f.path,
    add: f.additions,
    del: f.deletions,
  }))
