import type { z } from 'zod'
import type { ProposalEditBody } from '../policy-proposals'
import type { Principal } from '../auth'
import type { CursorPosition, Page } from '../cursor'
import type { EventLog } from '../events'
import type { Pre } from '../registry'
import type * as S from '../schemas'
import type { ForgeOps } from '../forge/ports'
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
export type RunnerWaitBody = WaitBody & {
  repo: string
  run: number
  job: number
  step: number
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

export type ProvenanceFacts = {
  change: {
    number: number
    title: string
    state: Out<typeof S.Change>['state']
    url: string
    html_url: string
  } | null
  patch_set: number | null
  via: Out<typeof S.Via> | null
  on_base: string | null
}

type Dry = boolean
type IfMatch = string | null
type Paging = { after: CursorPosition | null; limit: number }

export interface DomainPort {
  readonly urls: Urls
  readonly events: EventLog
  readonly svc: Attached
  readonly accessRevision: number
  sweepOperations: () => void | Promise<void>

  canActAs: (login: string, account: string) => Promise<boolean>
  canSee: (p: Viewer) => (full: string | null) => boolean | Promise<boolean>
  canSeeId: (p: Viewer) => (id: string | null) => boolean | Promise<boolean>
  mayReadId: (id: string | null, p: Viewer) => boolean | Promise<boolean>
  repoAccess: (
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write',
  ) => Promise<string>
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
  assertVersion: (
    ifMatch: IfMatch,
    version: string,
    current: () => unknown,
  ) => void
  replayKey: (
    opId: string,
    params: Record<string, string>,
    p: Principal,
  ) => { id: string; stamp: string } | Promise<{ id: string; stamp: string }>
  searchDocs: () => Iterable<SearchDoc>

  listAccounts: (p: Principal) => Promise<Array<Out<typeof S.Account>>>
  getAccount: (handle: string, p: Viewer) => Promise<Out<typeof S.Account>>
  accountVersion: (handle: string) => Promise<string | null>
  knowPerson: (handle: string, name: string) => Promise<void>
  updateAccount: (
    handle: string,
    p: Principal,
    body: { name?: string; bio?: string },
    ifMatch: IfMatch,
    dry: Dry,
  ) => Promise<Out<typeof S.Account>>
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
  acceptInvitation: (
    secret: string,
    p: Principal,
    dry: Dry,
  ) => Promise<Out<typeof S.Member>>
  repoVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  gitAccess: (
    owner: string,
    name: string,
    p: Viewer,
    need: 'read' | 'write',
  ) => Promise<{ storeId: string; defaultBranch: string }>
  commitFacts: (
    full: string,
    commits: ReadonlyArray<{ sha: string; author: { email: string } }>,
  ) => Promise<
    Array<Pick<Out<typeof S.GitCommit>, 'actor' | 'change' | 'checks'>>
  >
  getStar: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Star>>
  setStar: (
    owner: string,
    name: string,
    p: Principal,
    on: boolean,
    dry: Dry,
  ) => Promise<{ star: Out<typeof S.Star>; changed: boolean }>
  repoIdOf: (owner: string, name: string, p: Viewer) => Promise<string>
  repoIdForHistory: (full: string) => string | null | Promise<string | null>
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
      github_bot_writes?: boolean
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
  bumpRepo: (owner: string, name: string, p: Viewer) => Promise<void>
  context: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.Context>>
  numberRef: (
    owner: string,
    name: string,
    n: number,
    p: Viewer,
  ) => Promise<Out<typeof S.NumberRef>>

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

  getOperation: (id: string, p: Viewer) => Promise<Out<typeof S.Operation>>
  operationVersion: (id: string, p: Viewer) => Promise<string | null>
  operationRepoId: (id: string) => string | null | Promise<string | null>

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
  hiddenChanges: (repoId: string | null, p: Viewer) => Promise<Set<number>>

  getTriggers: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.TriggerSet>>
  triggersVersion: (owner: string, name: string, p: Viewer) => Promise<string>

  pendingRunsOn: () => Promise<
    Array<{
      owner: string
      name: string
      number: number
      file: string
      sha: string
    }>
  >
  setRunsOn: (
    owner: string,
    name: string,
    n: number,
    read: {
      jobs: Record<string, Array<string>>
      warnings: Array<string>
    } | null,
  ) => Promise<void>

  /** Queue a hand-off for the person's own agent (a runner labelled t3). */
  startHandoff: (
    owner: string,
    name: string,
    p: Principal,
    subject: string,
  ) => Promise<{ run: number | null; agent: boolean }>
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
  deleteRunner: (
    p: Viewer,
    id: string,
    dry: Dry,
  ) => Promise<Out<typeof S.Runner>>
  runnerHeartbeat: (p: Viewer) => Promise<Out<typeof S.Runner>>
  runnerClaim: (p: Viewer) => Promise<Out<typeof S.PipelineJob> | null>
  runnerReport: (
    p: Viewer,
    body: RunnerReportBody,
  ) => Promise<Out<typeof S.PipelineRun>>
  runnerWait: (
    p: Viewer,
    body: RunnerWaitBody,
  ) => Promise<Out<typeof S.PipelineRun>>
  runnerJobs: (p: Viewer, id: string) => Promise<Array<Out<typeof S.RunnerJob>>>

  getPolicySet: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.PolicySet>>
  policySetVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  policyInFile: (owner: string, name: string, p: Viewer) => Promise<boolean>
  proposePolicy: (
    owner: string,
    name: string,
    p: Viewer,
    edits: Array<ProposalEditBody>,
    dry: Dry,
  ) => Promise<Out<typeof S.PolicyProposal>>
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

  /** Accounts that proved these logins theirs, keyed by lowercased login. */
  handlesOfLogins: (
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea',
    logins: ReadonlyArray<string>,
  ) => Promise<Record<string, string>>
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
  /** One login on the host, or every linked account there when `login` is left out. */
  unlinkAccount: (
    handle: string,
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea',
    p: Viewer,
    login?: string,
  ) => Promise<void>
  importRepo: (
    p: Principal,
    body: {
      host: 'github' | 'gitlab' | 'codeberg' | 'gitea'
      slug: string
      owner?: string
      name?: string
      visibility: 'public' | 'private'
      github_access?: string
    },
    dry: Dry,
  ) => Promise<{ repo: Out<typeof S.Repo>; created: boolean }>
  listImports: (p: Viewer) => Promise<Array<Out<typeof S.Import>>>

  providerConnections: ForgeOps['providerConnections']
  providerRepos: ForgeOps['providerRepos']
  providerOauthStart: ForgeOps['providerOauthStart']
  providerOauthFinish: ForgeOps['providerOauthFinish']
  providerDisconnect: ForgeOps['providerDisconnect']
  providerAudit: ForgeOps['providerAudit']
  importBatch: ForgeOps['importBatch']
  importJob: ForgeOps['importJob']
  repoProvider: ForgeOps['repoProvider']
  adoptProvider: ForgeOps['adoptProvider']
  refreshProvider: ForgeOps['refreshProvider']
  remoteList: ForgeOps['remoteList']
  remotePull: ForgeOps['remotePull']
  remoteIssue: ForgeOps['remoteIssue']
  remoteComments: ForgeOps['remoteComments']
  remotePatch: ForgeOps['remotePatch']

  githubDeviceStart: (p: Principal) => Promise<Out<typeof S.GithubDevice>>
  githubDevicePoll: (
    p: Principal,
    deviceCode: string,
  ) => Promise<Out<typeof S.GithubDeviceStatus>>
  githubRepos: (
    p: Principal,
    access: string,
  ) => Promise<Array<Out<typeof S.GithubRepo>>>
  githubOauthStart: (
    p: Principal,
    redirectUri: string,
    returnTo: string | null,
  ) => Promise<Out<typeof S.GithubOauth>>
  githubOauthFinish: (
    p: Principal,
    body: { code: string; state: string; redirect_uri: string },
  ) => Promise<Out<typeof S.GithubOauthResult>>

  createMirror: (
    p: Principal,
    owner: string,
    name: string,
    body: {
      host: string
      slug: string
      direction: 'push' | 'pull' | 'two-way'
      github_access?: string
    },
    dry: Dry,
  ) => Promise<{ mirror: Out<typeof S.Mirror>; created: boolean }>
  syncMirror: (
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    dry: Dry,
  ) => Promise<Out<typeof S.Mirror>>
  updateMirror: (
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    body: { paused?: boolean; direction?: 'push' | 'pull' | 'two-way' },
    dry: Dry,
  ) => Promise<Out<typeof S.Mirror>>
  deleteMirror: (
    p: Principal,
    owner: string,
    name: string,
    mirror: string,
    dry: Dry,
  ) => Promise<void>

  repoInsights: (
    owner: string,
    name: string,
    p: Viewer,
  ) => Promise<Out<typeof S.RepoInsights>>
  insightsVersion: (owner: string, name: string, p: Viewer) => Promise<string>
  inbox: (p: Viewer, limit: number) => Promise<Out<typeof S.Inbox>>
  dashboard: (p: Viewer, account?: string) => Promise<Out<typeof S.Dashboard>>

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
  presence: (
    owner: string,
    name: string,
    subject: { kind: 'change' | 'issue'; ref: string },
    p: Principal,
  ) => Promise<Out<typeof S.Presence>>
  heartbeat: (
    owner: string,
    name: string,
    subject: { kind: 'change' | 'issue'; ref: string },
    p: Principal,
    body: { session: string; path: string | null; leave: boolean },
  ) => Promise<Out<typeof S.Presence>>
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
  transition: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    action: 'ready' | 'abandon' | 'restore',
    dry: Dry,
  ) => Promise<Out<typeof S.Change>>
  autoLandCandidate: (
    owner: string,
    name: string,
    ref: string,
  ) => Promise<{ full: string; by: string; base: string; sha: string } | null>
  autoLand: (
    owner: string,
    name: string,
    ref: string,
    sha: string,
  ) => Promise<boolean>
  land: (
    owner: string,
    name: string,
    ref: string,
    p: Viewer,
    body: { expected_tree: string },
    dry: Dry,
  ) => Promise<Out<typeof S.Change> | { operation: Out<typeof S.Operation> }>
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

  listEvents: (
    p: Viewer,
    q: Paging & { repo?: string; type?: string },
  ) => Promise<Page<Pre>>
  eventVersion: () => string | Promise<string>
  repoHistoryVersion: (full: string, p: Viewer) => Promise<string>
  sync: (
    p: Viewer,
    q: { repo: string; cursor?: string; limit: number },
  ) => Promise<Out<typeof S.Sync>>
  syncVersion: (owner: string, name: string, p: Viewer) => Promise<string>
}
