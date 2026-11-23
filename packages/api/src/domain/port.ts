import type { z } from 'zod'
import type { ProposalEditBody } from '../policy-proposals'
import type { Principal } from '../auth'
import type { CursorPosition, Page } from '../cursor'
import type { EventLog } from '../events'
import type { Pre } from '../registry'
import type * as S from '../schemas'
import type { SearchDoc } from '../search'
import type { UploadRec } from '../uploads'
import type { GuideBody } from '../guides'
import type {
  Assume,
  Attached,
  CheckRec,
  EvidenceRec,
  LabelColor,
  NotificationKind,
  ReviewRec,
  Urls,
  Viewer,
} from './records'

type Out<TSchema extends z.ZodType> = z.output<TSchema>

export type WaitBody = {
  kind: 'person' | 'agent' | 'approval'
  reason: string
  target?: string | null
  expires_at?: string
}
export type ResumeBody = {
  status: 'success' | 'failure'
  summary?: string
  lines?: Array<{
    text: string
    level?: 'cmd' | 'info' | 'ok' | 'warn' | 'error' | null
  }>
}
export type RunnerBody = {
  name: string
  account?: string
  kind?: 'self-hosted' | 'hosted'
  provider?: string | null
  labels?: Array<string>
  repos?: Array<string> | null
  concurrency?: number
}
export type RunnerReportBody = {
  repo: string
  run: number
  job: number
  step: number
  status: 'running' | 'success' | 'failure' | 'skipped'
  lines?: Array<{
    text: string
    level?: 'cmd' | 'info' | 'ok' | 'warn' | 'error' | null
  }>
  duration_ms?: number
}

/** What the forge knows about where a line came from. */
export type ProvenanceFacts = {
  change: {
    number: number
    title: string
    state: Out<typeof S.Change>['state']
    url: string
    html_url: string
  } | null
  patch_set: number | null
  /** How that patch set got here: machine, tool and declared model. */
  via: Out<typeof S.Via> | null
  /** The line was already on the change's base, this branch: blame it there. */
  on_base: string | null
}

type Dry = boolean
type IfMatch = string | null
type Paging = { after: CursorPosition | null; limit: number }

/**
 * What the API needs from its data. This is the whole surface the pipeline
 * and the operations call, and nothing else: it was sized by listing every
 * member they use. `MemoryDomain` implements it today; the hosted version
 * implements it on Convex, and neither the pipeline nor an operation changes.
 *
 * It is written in terms of the public objects (`schemas.ts`), never in terms
 * of how one implementation stores them. Seeding is not part of it: that
 * belongs to the implementation and to the tests.
 *
 * Rules an implementation keeps:
 *  - a method that reads checks the caller first; a private thing is `not_found`
 *  - a write bumps the object's `version` and emits exactly one event
 *  - `dry` runs the same checks and writes nothing
 *  - a `*Version` method answers without building the object
 */
export interface DomainPort {
  // ---- wiring -------------------------------------------------------------

  /** Where links in responses point. */
  readonly urls: Urls
  /** The event log every write appends to. */
  readonly events: EventLog
  /** Tokens, webhooks, search, uploads, extras and git, attached at assembly. */
  readonly svc: Attached
  /** Rises on every access change, so cached bodies cannot outlive access. */
  readonly accessRevision: number
  /** Housekeeping: drop finished operations after a week. */
  sweepOperations: () => void | Promise<void>

  // ---- access -------------------------------------------------------------

  /** Whether `login` may act as `account` (itself, or an organization it is in). */
  canActAs: (login: string, account: string) => Promise<boolean>
  /** A predicate for the repositories `p` can read. Null means account-level. */
  canSee: (p: Viewer) => (full: string | null) => boolean | Promise<boolean>
  canSeeId: (p: Viewer) => (id: string | null) => boolean | Promise<boolean>
  /** Whether the caller may read the repository with this stable id. */
  mayReadId: (id: string | null, p: Viewer) => boolean | Promise<boolean>
  /** Checks the caller may read or write a repository, and names it `owner/name`. */
  repoAccess: (
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write',
  ) => Promise<string>
  /** Read access that requires a real relationship, not public visibility. */
  /** The caller's place in a repository's secrets team, and its stable id. */
  secretsAccess: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<{ full: string; repoId: string; team: boolean }>
  repoAccessStrict: (
    owner: string,
    name: string,
    p: Viewer,
    need?: 'read' | 'write',
  ) => Promise<string>
  /** For operations that keep their own versioned records. Throws on a mismatch. */
  assertVersion: (
    ifMatch: IfMatch,
    version: string,
    current: () => unknown,
  ) => void
  /** The stable repository identity and access stamp for a keyed write. */
  replayKey: (
    opId: string,
    params: Record<string, string>,
    p: Principal,
  ) => { id: string; stamp: string } | Promise<{ id: string; stamp: string }>
  /** Every searchable thing, for building the search index. */
  searchDocs: () => Iterable<SearchDoc>

  // ---- accounts and repositories -----------------------------------------

  listAccounts: (p: Principal) => Promise<Array<Out<typeof S.Account>>>
  getAccount: (handle: string, p: Viewer) => Promise<Out<typeof S.Account>>
  accountVersion: (handle: string) => Promise<string | null>
  /**
   * A person signed in. The server calls this once it knows who they are; no
   * operation does, so it takes no caller and checks nothing.
   */
  knowPerson: (handle: string, name: string) => Promise<void>
  updateAccount: (
    handle: string,
    p: Principal,
    body: { name?: string; bio?: string },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Account>>
  /** Create an organization owned by the caller. Repeat-safe on the handle. */
  createOrganization: (
    p: Principal,
    input: { handle: string; name?: string; bio?: string },
    dry: Dry,
  ) => Promise<{ account: Out<typeof S.Account>; created: boolean }>
  listMembers: (
    handle: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.Member>>>
  membersVersion: (handle: string, p: Viewer) => Promise<string>
  /** Add a person to an organization or change their role. */
  setMember: (
    handle: string,
    login: string,
    role: 'owner' | 'admin' | 'member',
    p: Principal,
    dry: Dry,
  ) => Promise<{
    member: Out<typeof S.Member>
    outcome: 'created' | 'updated' | 'unchanged'
  }>
  removeMember: (
    handle: string,
    login: string,
    p: Principal,
    dry: Dry,
  ) => Promise<void>

  listRepos: (
    p: Viewer,
    q: Paging & { owner?: string },
  ) => Promise<Page<Out<typeof S.Repo>>>
  getRepo: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Repo>>
  listInvitations: (
    handle: string,
    p: Principal,
  ) => Promise<Array<Out<typeof S.Invitation>>>
  /** Invite by email. The link goes out through `svc.mail`. */
  invite: (
    handle: string,
    p: Principal,
    input: { email: string; role: Out<typeof S.Member>['role'] },
    dry: Dry,
  ) => Promise<{
    invitation: Out<typeof S.Invitation>
    outcome: 'created' | 'updated'
  }>
  revokeInvitation: (
    handle: string,
    id: string,
    p: Principal,
    dry: Dry,
  ) => Promise<void>
  /** Join with the secret from an invitation's link. */
  acceptInvitation: (
    secret: string,
    p: Principal,
    dry: Dry,
  ) => Promise<Out<typeof S.Member>>
  repoVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  /** Per commit: the account behind its author, its change and its checks. */
  commitFacts: (
    full: string,
    commits: ReadonlyArray<{ sha: string; author: { email: string } }>,
  ) => Promise<
    Array<Pick<Out<typeof S.GitCommit>, 'actor' | 'change' | 'checks'>>
  >
  /** Whether the caller starred it, and how many people did. */
  getStar: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Star>>
  /** Star or unstar, as a person. `changed` is false when it already was so. */
  setStar: (
    owner: string,
    name: string,
    p: Principal,
    on: boolean,
    dry: Dry,
  ) => Promise<{ star: Out<typeof S.Star>; changed: boolean }>
  /** The repository id behind an address, after checking the caller may read it. */
  repoIdOf: (owner: string, name: string, p: Viewer) => Promise<string>
  /** The stable id behind an address, without requiring that it still exists. */
  repoIdForHistory: (full: string) => string | null | Promise<string | null>
  /** The current `owner/name` for an address, following renames, unchecked. */
  canonicalRepoName: (full: string) => string | Promise<string>
  createRepo: (
    p: Principal,
    input: {
      owner?: string
      name: string
      description?: string
      visibility: 'public' | 'private'
      maintainers?: Array<string>
    },
    dry: Dry,
  ) => Promise<{ repo: Out<typeof S.Repo>; created: boolean }>
  updateRepo: (
    owner: string,
    name: string,
    p: Principal,
    body: {
      name?: string
      description?: string
      visibility?: 'public' | 'private'
      default_branch?: string
      maintainers?: Array<string>
      category?: Out<typeof S.Repo>['category'] | null
      website?: string | null
      docs_url?: string | null
      install?: string | null
      declined_models?: Array<string>
      auto_land?: boolean
      vouched?: Array<string>
      denounced?: Array<{ handle: string; reason: string }>
    },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Repo>>
  transferRepo: (
    owner: string,
    name: string,
    p: Principal,
    body: { owner: string; name?: string; confirm: string },
    dry: Dry,
  ) => Promise<Out<typeof S.Repo>>
  deleteRepo: (
    owner: string,
    name: string,
    p: Principal,
    confirm: string | undefined,
    dry: Dry,
  ) => Promise<{ deleted: boolean; full: string }>
  /** Marks a repository's derived state as changed, without an event. */
  bumpRepo: (owner: string, name: string, p: Viewer) => Promise<void>
  context: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Context>>
  /** Whether a number in a repository is a change or an issue. */
  numberRef: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.NumberRef>>

  // ---- teams --------------------------------------------------------------

  listTeams: (org: string, p: Principal) => Promise<Array<Out<typeof S.Team>>>
  getTeam: (
    org: string,
    slug: string,
    p: Principal,
  ) => Promise<Out<typeof S.Team>>
  teamVersion: (org: string, slug: string, p: Principal) => Promise<string>
  createTeam: (
    org: string,
    p: Principal,
    input: { slug: string; name?: string; description?: string },
    dry: Dry,
  ) => Promise<{ team: Out<typeof S.Team>; created: boolean }>
  updateTeam: (
    org: string,
    slug: string,
    p: Principal,
    body: { name?: string; description?: string },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Team>>
  deleteTeam: (
    org: string,
    slug: string,
    p: Principal,
    dry: Dry,
  ) => Promise<void>
  setTeamMember: (
    org: string,
    slug: string,
    login: string,
    p: Principal,
    dry: Dry,
  ) => Promise<Out<typeof S.Team>>
  removeTeamMember: (
    org: string,
    slug: string,
    login: string,
    p: Principal,
    dry: Dry,
  ) => Promise<void>
  setTeamRepo: (
    org: string,
    slug: string,
    owner: string,
    name: string,
    permission: 'read' | 'write',
    p: Principal,
    dry: Dry,
  ) => Promise<Out<typeof S.Team>>
  removeTeamRepo: (
    org: string,
    slug: string,
    owner: string,
    name: string,
    p: Principal,
    dry: Dry,
  ) => Promise<void>

  // ---- long operations -------------------------------------------------

  getOperation: (id: string, p: Viewer) => Promise<Out<typeof S.Operation>>
  operationVersion: (id: string, p: Viewer) => Promise<string | null>
  /** The repository an operation belongs to, for waiting on it. Unchecked. */
  operationRepoId: (id: string) => string | null | Promise<string | null>

  // ---- issues -------------------------------------------------------------

  listIssues: (
    owner: string,
    name: string,
    p: Viewer,
    q: Paging & { state: string; label?: string; author?: string },
  ) => Promise<Page<Pre>>
  issueListVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  getIssue: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.Issue>>
  issueVersion: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<string | null>
  createIssue: (
    owner: string,
    name: string,
    p: Viewer,
    body: {
      title: string
      body?: string
      labels?: Array<string>
      assignees?: Array<string>
    },
    dry: Dry,
  ) => Promise<{
    issue: Out<typeof S.Issue>
    outcome: 'created' | 'unchanged'
  }>
  updateIssue: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    body: {
      title?: string
      body?: string
      labels?: Array<string>
      state?: 'open' | 'closed'
      assignees?: Array<string>
    },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Issue>>

  // ---- releases -------------------------------------------------------------

  listReleases: (
    owner: string,
    name: string,
    p: Viewer,
    q: Paging & { channel?: 'stable' | 'beta' | 'nightly' },
  ) => Promise<Page<Out<typeof S.Release>>>
  releasesVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  getRelease: (
    owner: string,
    name: string,
    tag: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Release>>
  createRelease: (
    owner: string,
    name: string,
    p: Viewer,
    body: {
      tag: string
      channel: 'stable' | 'beta' | 'nightly'
      title: string
      notes?: {
        added?: Array<string>
        changed?: Array<string>
        fixed?: Array<string>
      }
      signed?: boolean
      commit?: string
      assets?: Array<{
        name: string
        platform: 'macos' | 'windows' | 'linux'
        arch: string
        size?: number
        sha256?: string
        upload?: string
      }>
    },
    dry: Dry,
  ) => Promise<{
    release: Out<typeof S.Release>
    outcome: 'created' | 'unchanged'
  }>
  updateRelease: (
    owner: string,
    name: string,
    tag: string,
    p: Viewer,
    body: {
      title?: string
      notes?: {
        added?: Array<string>
        changed?: Array<string>
        fixed?: Array<string>
      }
      withdrawn?: string | null
    },
    dry: Dry,
  ) => Promise<Out<typeof S.Release>>
  downloadAsset: (
    owner: string,
    name: string,
    tag: string,
    asset: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Download>>

  // ---- pipelines ------------------------------------------------------------

  listPipelineRuns: (
    owner: string,
    name: string,
    p: Viewer,
    q: Paging & {
      status?:
        | 'queued'
        | 'running'
        | 'waiting'
        | 'success'
        | 'failure'
        | 'canceled'
      workflow?: string
    },
  ) => Promise<Page<Out<typeof S.PipelineRun>>>
  pipelinesVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  getPipelineRun: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.PipelineRun>>
  getPipelineLog: (
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
  ) => Promise<Out<typeof S.PipelineLog>>
  startPipeline: (
    owner: string,
    name: string,
    p: Viewer,
    body: { workflow: string; branch?: string },
    dry: Dry,
  ) => Promise<Out<typeof S.PipelineRun>>
  claimPipelineJob: (
    owner: string,
    name: string,
    p: Viewer,
    body: { runner: string },
  ) => Promise<Out<typeof S.PipelineJob> | null>
  reportPipelineStep: (
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: {
      status: 'running' | 'success' | 'failure' | 'skipped'
      lines?: Array<{
        text: string
        level?: 'cmd' | 'info' | 'ok' | 'warn' | 'error' | null
      }>
      duration_ms?: number
    },
  ) => Promise<Out<typeof S.PipelineRun>>
  rerunPipeline: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    dry: Dry,
  ) => Promise<Out<typeof S.PipelineRun>>
  cancelPipeline: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    dry: Dry,
  ) => Promise<Out<typeof S.PipelineRun>>
  /** Pause a running step for a person or an outside agent. */
  waitPipelineStep: (
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: WaitBody,
    dry: Dry,
  ) => Promise<Out<typeof S.PipelineRun>>
  /** Resume a waiting step with how it ended. */
  resumePipelineStep: (
    owner: string,
    name: string,
    n: number,
    job: number,
    step: number,
    p: Viewer,
    body: ResumeBody,
    dry: Dry,
  ) => Promise<Out<typeof S.PipelineRun>>

  // ---- access rules ---------------------------------------------------------

  /** The rules the viewer administers or reads. */
  listAccessRules: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.AccessRule>>>
  putAccessRule: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    body: {
      kind: 'branch' | 'path'
      patterns: Array<string>
      readers: Array<string>
    },
    dry: Dry,
  ) => Promise<{ rule: Out<typeof S.AccessRule>; created: boolean }>
  deleteAccessRule: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>
  /** What a viewer may not see in a repository: hidden branch and path globs. */
  accessView: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<{
    hidden: Array<{
      id: string
      kind: 'branch' | 'path'
      patterns: Array<string>
    }>
  }>
  /** The numbers of a repository's changes the viewer may not see. */
  hiddenChanges: (repoId: string | null, p: Viewer) => Promise<Set<number>>

  // ---- triggers -------------------------------------------------------------

  /** The triggers in force, their files and what they did lately. */
  getTriggers: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.TriggerSet>>
  triggersVersion: (owner: string, name: string, p: Viewer) => Promise<string>

  // ---- runners --------------------------------------------------------------

  createRunner: (
    p: Viewer,
    body: RunnerBody,
    dry: Dry,
  ) => Promise<Out<typeof S.Runner>>
  listRunners: (
    p: Viewer,
    account: string | undefined,
  ) => Promise<Array<Out<typeof S.Runner>>>
  getRunner: (p: Viewer, id: string) => Promise<Out<typeof S.Runner>>
  updateRunner: (
    p: Viewer,
    id: string,
    body: Partial<Omit<RunnerBody, 'account' | 'kind' | 'provider'>>,
    dry: Dry,
  ) => Promise<Out<typeof S.Runner>>
  /** Disables the runner and revokes its token, in one write. */
  deleteRunner: (
    p: Viewer,
    id: string,
    dry: Dry,
  ) => Promise<Out<typeof S.Runner>>
  /** The runner says it is alive; the leases on its running jobs are extended. */
  runnerHeartbeat: (p: Viewer) => Promise<Out<typeof S.Runner>>
  /** The oldest queued job this runner may take, now its; null when none. */
  runnerClaim: (p: Viewer) => Promise<Out<typeof S.PipelineJob> | null>
  runnerReport: (
    p: Viewer,
    body: RunnerReportBody,
  ) => Promise<Out<typeof S.PipelineRun>>
  runnerJobs: (p: Viewer, id: string) => Promise<Array<Out<typeof S.RunnerJob>>>

  // ---- policy rules ---------------------------------------------------------

  getPolicySet: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.PolicySet>>
  policySetVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  /** Whether the rules live in the policy file, so writes propose. */
  policyInFile: (owner: string, name: string, p: Viewer) => Promise<boolean>
  /** Edits to the rules as a change to the policy file. */
  proposePolicy: (
    owner: string,
    name: string,
    p: Viewer,
    edits: Array<ProposalEditBody>,
    dry: Dry,
  ) => Promise<Out<typeof S.PolicyProposal>>
  /** What stops a change from landing now, and how it will land. */
  landability: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Landability>>
  setRuleMode: (
    owner: string,
    name: string,
    rule: string,
    p: Viewer,
    mode: 'enforce' | 'dry-run' | 'off',
    dry: Dry,
  ) => Promise<Out<typeof S.PolicySet>['rules'][number]>
  createRule: (
    owner: string,
    name: string,
    p: Viewer,
    body: {
      id: string
      name: string
      kind: 'required_check' | 'path_approval' | 'max_lines' | 'allowed_paths'
      check?: string
      paths?: Array<string>
      approvals?: number
      from?: Array<string>
      max_lines?: number
      mode?: 'enforce' | 'dry-run' | 'off'
    },
    dry: Dry,
  ) => Promise<{
    rule: Out<typeof S.PolicySet>['rules'][number]
    created: boolean
  }>
  deleteRule: (
    owner: string,
    name: string,
    rule: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>
  addPolicyException: (
    owner: string,
    name: string,
    p: Viewer,
    body: { rule: string; who: string; reason: string; expires_at: string },
    dry: Dry,
  ) => Promise<Out<typeof S.PolicyException>>
  removePolicyException: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>

  // ---- integrations ---------------------------------------------------------

  listConnections: (
    handle: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.IntegrationConnection>>>
  connectionsVersion: (handle: string, p: Viewer) => Promise<string>
  connect: (
    handle: string,
    id: string,
    p: Viewer,
    body: { key?: string },
    dry: Dry,
  ) => Promise<{
    connection: Out<typeof S.IntegrationConnection>
    created: boolean
  }>
  disconnect: (handle: string, id: string, p: Viewer, dry: Dry) => Promise<void>
  listRepoIntegrations: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.RepoIntegration>>>
  repoIntegrationsVersion: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<string>
  setRepoIntegration: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    on: boolean,
    dry: Dry,
  ) => Promise<Out<typeof S.RepoIntegration>>

  // ---- imports and linked accounts -----------------------------------------

  listLinks: (
    handle: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.LinkedAccount>>>
  linkAccount: (
    handle: string,
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea',
    p: Viewer,
    body: { login: string; instance?: string },
  ) => Promise<Out<typeof S.LinkedAccount>>
  unlinkAccount: (
    handle: string,
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea',
    p: Viewer,
  ) => Promise<void>
  importRepo: (
    p: Principal,
    body: {
      host: 'github' | 'gitlab' | 'codeberg' | 'gitea'
      slug: string
      owner?: string
      name?: string
      visibility: 'public' | 'private'
    },
    dry: Dry,
  ) => Promise<{ repo: Out<typeof S.Repo>; created: boolean }>
  listImports: (p: Viewer) => Promise<Array<Out<typeof S.Import>>>

  // ---- insights and the dashboard -----------------------------------------

  repoInsights: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.RepoInsights>>
  insightsVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  /** What needs the viewer now, worked out from the state of things. */
  inbox: (p: Viewer, limit: number) => Promise<Out<typeof S.Inbox>>
  dashboard: (p: Viewer, account?: string) => Promise<Out<typeof S.Dashboard>>

  // ---- notifications --------------------------------------------------------

  listNotifications: (
    p: Viewer,
    q: Paging & { unread?: boolean; kind?: NotificationKind },
  ) => Promise<Page<Out<typeof S.Notification>>>
  notificationsVersion: (p: Viewer) => Promise<string>
  getAccountPrefs: (p: Viewer) => Promise<Out<typeof S.AccountPreferences>>
  updateAccountPrefs: (
    p: Viewer,
    body: Partial<Omit<Out<typeof S.AccountPreferences>, 'object'>>,
  ) => Promise<Out<typeof S.AccountPreferences>>
  follow: (p: Viewer, handle: string, on: boolean) => Promise<void>
  listFollows: (
    handle: string,
    which: 'followers' | 'following',
    q: { after: CursorPosition | null; limit: number },
  ) => Promise<{
    items: Array<Out<typeof S.AccountRef>>
    next: CursorPosition | null
  }>
  peopleVersion: (p: Viewer) => Promise<string>
  profile: (handle: string, p: Viewer) => Promise<Out<typeof S.Profile>>
  profileVersion: (handle: string, p: Viewer) => Promise<string>
  listPeople: (
    p: Viewer,
    q: { q?: string; after: CursorPosition | null; limit: number },
  ) => Promise<{
    items: Array<Out<typeof S.PersonEntry>>
    next: CursorPosition | null
  }>
  unreadCount: (p: Viewer) => Promise<Out<typeof S.NotificationCount>>
  markRead: (p: Viewer, id: string | null) => Promise<void>
  getNotificationPrefs: (
    p: Viewer,
  ) => Promise<Out<typeof S.NotificationPreferences>>
  updateNotificationPrefs: (
    p: Viewer,
    body: Partial<Record<NotificationKind | 'digest', boolean>>,
  ) => Promise<Out<typeof S.NotificationPreferences>>

  // ---- labels and issue comments -------------------------------------------

  listLabels: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.Label>>>
  labelsVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  createLabel: (
    owner: string,
    name: string,
    p: Viewer,
    body: { name: string; color?: LabelColor; description?: string },
    dry: Dry,
  ) => Promise<{
    label: Out<typeof S.Label>
    outcome: 'created' | 'unchanged'
  }>
  updateLabel: (
    owner: string,
    name: string,
    label: string,
    p: Viewer,
    body: { name?: string; color?: LabelColor; description?: string },
    dry: Dry,
  ) => Promise<Out<typeof S.Label>>
  deleteLabel: (
    owner: string,
    name: string,
    label: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>
  listComments: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    q: Paging,
  ) => Promise<Page<Out<typeof S.IssueComment>>>
  commentsVersion: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<string | null>
  createComment: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    body: { body: string },
    dry: Dry,
  ) => Promise<Out<typeof S.IssueComment>>
  updateComment: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    body: { body: string },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.IssueComment>>
  deleteComment: (
    owner: string,
    name: string,
    id: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>

  // ---- changes ------------------------------------------------------------
  // `ref` is the change number or its `chg_` id.

  listChanges: (
    owner: string,
    name: string,
    p: Viewer,
    q: Paging & {
      state?: string
      author?: string
      label?: string
      branch?: string
      sort: 'updated_at' | 'number'
      desc: boolean
      expand: ReadonlyArray<string>
    },
  ) => Promise<Page<Pre>>
  changeListVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  getChange: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    expand?: ReadonlyArray<string>,
  ) => Promise<Pre>
  changeVersion: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    expand?: ReadonlyArray<string>,
  ) => Promise<string>
  /**
   * Where a line came from: in a change (`change`), the patch set that wrote
   * it; for a commit git blamed (`sha`), the change and patch set it landed
   * through. Either way, the run that made that patch set.
   */
  provenance: (
    owner: string,
    name: string,
    p: Viewer,
    q: { path: string; line: number; change?: number; sha?: string },
  ) => Promise<ProvenanceFacts>
  getGuide: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
  ) => Promise<Out<typeof S.ChangeGuide>>
  putGuide: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: GuideBody,
    dry: Dry,
  ) => Promise<Out<typeof S.ChangeGuide>>
  /** Which files of a change the caller has seen as they are now. */
  changeSeen: (
    owner: string,
    name: string,
    ref: string,
    p: Principal,
  ) => Promise<Out<typeof S.ChangeSeen>>
  setSeen: (
    owner: string,
    name: string,
    ref: string,
    p: Principal,
    body: { paths: Array<string>; seen: boolean },
    dry: Dry,
  ) => Promise<Out<typeof S.ChangeSeen>>
  /** Who is looking at a change or an issue now. */
  presence: (
    owner: string,
    name: string,
    subject: { kind: 'change' | 'issue'; ref: string },
    p: Principal,
  ) => Promise<Out<typeof S.Presence>>
  /** The caller is looking at it (or has left), then who is. */
  heartbeat: (
    owner: string,
    name: string,
    subject: { kind: 'change' | 'issue'; ref: string },
    p: Principal,
    body: { session: string; path: string | null; leave: boolean },
  ) => Promise<Out<typeof S.Presence>>
  /** Everything that happened to a change or an issue, oldest first. */
  timeline: (
    owner: string,
    name: string,
    subject: { kind: 'change' | 'issue'; ref: string },
    p: Viewer,
  ) => Promise<Array<Out<typeof S.TimelineEntry>>>
  createChange: (
    owner: string,
    name: string,
    p: Viewer,
    body: {
      branch: string
      base?: string
      title?: string
      description?: string
      draft?: boolean
      sha?: string
      message?: string
      addresses?: Array<{ comment: string; note?: string }>
      dry_run?: boolean
    },
  ) => Promise<{
    change: Out<typeof S.Change>
    outcome: 'created' | 'patch_set_added' | 'unchanged'
  }>
  updateChange: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: { title?: string; description?: string; labels?: Array<string> },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Change>>
  /** Mark a draft ready, abandon, restore. */
  transition: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    action: 'ready' | 'abandon' | 'restore',
    dry: Dry,
  ) => Promise<Out<typeof S.Change>>
  /**
   * Whether a change could land by itself now, all but the paths it touches,
   * which only the API server can read from git. Null when it may not.
   */
  autoLandCandidate: (
    owner: string,
    name: string,
    ref: string,
  ) => Promise<{ full: string; by: string; base: string; sha: string } | null>
  /** Lands it under the account that turned auto-land on, if still at `sha`. */
  autoLand: (
    owner: string,
    name: string,
    ref: string,
    sha: string,
  ) => Promise<boolean>
  /** Land one change. `expected_tree` must be the tree that was checked. */
  land: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: { expected_tree: string },
    dry: Dry,
    /** The landed change; or, when the policy file has steps after landing, the operation that runs them. */
  ) => Promise<Out<typeof S.Change> | { operation: Out<typeof S.Operation> }>
  /** Land a stack bottom-up as one long operation. */
  landStack: (
    owner: string,
    name: string,
    stackId: string,
    p: Viewer,
    body: { expected_trees: Record<string, string> },
    dry: Dry,
  ) => Promise<Out<typeof S.Operation>>

  listPatchSets: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.PatchSet>>>
  getPatchSet: (
    owner: string,
    name: string,
    ref: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.PatchSet>>
  addPatchSet: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: {
      sha?: string
      kind: 'update' | 'rebase'
      note?: string
      files?: Record<string, string | null>
      addresses?: Array<{ comment: string; note?: string }>
    },
    dry: Dry,
  ) => Promise<Out<typeof S.PatchSet>>
  getPatchSetFiles: (
    owner: string,
    name: string,
    ref: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.PatchSetFiles>>
  comparePatchSets: (
    owner: string,
    name: string,
    ref: string,
    from: number,
    to: number,
    p: Viewer,
  ) => Promise<Out<typeof S.PatchSetComparison>>

  review: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: { state: ReviewRec['state']; body?: string; patch_set?: number },
    dry: Dry,
  ) => Promise<Out<typeof S.Review>>
  listReviewComments: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    q: { file?: string; unresolved?: boolean },
  ) => Promise<Array<Out<typeof S.ChangeComment>>>
  reviewCommentsVersion: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
  ) => Promise<string | null>
  addressReviewComment: (
    owner: string,
    name: string,
    ref: string,
    id: string,
    p: Viewer,
    body: { patch_set?: number; note?: string },
    dry: Dry,
  ) => Promise<Out<typeof S.ChangeComment>>
  createReviewComment: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: {
      body: string
      file?: string
      line?: number
      patch_set?: number
      reply_to?: string
      quote?: string
    },
    dry: Dry,
  ) => Promise<Out<typeof S.ChangeComment>>
  updateReviewComment: (
    owner: string,
    name: string,
    ref: string,
    id: string,
    p: Viewer,
    body: { body?: string; resolved?: boolean },
    dry: Dry,
  ) => Promise<Out<typeof S.ChangeComment>>
  deleteReviewComment: (
    owner: string,
    name: string,
    ref: string,
    id: string,
    p: Viewer,
    dry: Dry,
  ) => Promise<void>
  listFindings: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    state?: string,
  ) => Promise<Array<Out<typeof S.Finding>>>
  raiseFinding: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: {
      severity: 'high' | 'medium' | 'low'
      file: string
      line: number
      title: string
      body?: string
      suggestion?: {
        summary: string
        file: string
        replace: Array<string>
        after: string | null
        lines: Array<string>
      }
      prompt?: string
    },
    dry: Dry,
  ) => Promise<Out<typeof S.Finding>>
  setFinding: (
    owner: string,
    name: string,
    ref: string,
    findingId: string,
    p: Viewer,
    to: 'resolved' | 'dismissed',
    reason: string | null,
    dry: Dry,
  ) => Promise<Out<typeof S.Finding>>
  listChecks: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
  ) => Promise<Array<Out<typeof S.CheckRun>>>
  reportCheck: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: {
      key: string
      state: CheckRec['state']
      tree: string
      name?: string
      details_url?: string
      cases?: Array<Out<typeof S.TestCase>>
    },
    dry: Dry,
  ) => Promise<{
    check: Out<typeof S.CheckRun>
    outcome: 'created' | 'updated' | 'unchanged'
  }>
  /** Evaluate policy for a change, optionally assuming checks or findings. */
  policy: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    assume?: Assume,
  ) => Promise<Out<typeof S.PolicyEvaluation>>

  listEvidence: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    find: (id: string) => UploadRec | null | Promise<UploadRec | null>,
  ) => Promise<Array<Out<typeof S.Evidence>>>
  status: () => Promise<Out<typeof S.Status>>
  addIssueEvidence: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    input: { upload: UploadRec; kind: 'image' | 'recording'; caption: string },
    dry: Dry,
  ) => Promise<Out<typeof S.IssueEvidence>>
  listIssueEvidence: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
    find: (id: string) => UploadRec | null | Promise<UploadRec | null>,
  ) => Promise<Array<Out<typeof S.IssueEvidence>>>
  addEvidence: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    input: { upload: UploadRec; kind: EvidenceRec['kind']; caption: string },
    dry: Dry,
  ) => Promise<Out<typeof S.Evidence>>

  // ---- events and sync ----------------------------------------------------

  listEvents: (
    p: Viewer,
    q: Paging & { repo?: string; type?: string },
  ) => Promise<Page<Pre>>
  /** The event log's position, for conditional reads of the log itself. */
  eventVersion: () => string | Promise<string>
  /** The log's position for one repository, after checking read access. */
  repoHistoryVersion: (full: string, p: Viewer) => Promise<string>
  sync: (
    p: Viewer,
    q: { repo: string; cursor?: string; limit: number },
  ) => Promise<Out<typeof S.Sync>>
  syncVersion: (owner: string, name: string, p: Viewer) => Promise<string>
}
