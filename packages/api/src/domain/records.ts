import type { PlanId } from '../plans'
import type { SecretBox } from '../secret-box'
import type { Receipt } from '../via'
import type { LandingStepRec } from '../landing'
import type { FileError, Landing } from '../policy-file'
import type { AccessRule } from '../access-rules'
import type { Trigger, FileError as TriggerFileError } from '../trigger-file'
import type { Addressed, Anchor, Placement } from '../anchors'
import type { HookPort } from '../webhooks'
import type { SearchIndex } from '../search'
import type { GitData } from '../git'
import type { Github } from '../github'
import type { ProviderSync } from '../forge/sync'
import type { Mailer } from '../mail'
import type { Health } from '../health'
import type { UploadPort } from '../uploads'
import type { ExtrasPort } from '../extras'
import type { Principal, TokenService } from '../auth'
import type { z } from 'zod'
import type * as S from '../schemas'

export type Urls = { api: string; html: string }

export class Moved extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`${from} moved to ${to}`)
  }
}

export type ActorRec = { id: string; handle: string }
export type Role = 'owner' | 'admin' | 'member'

export type AccountRec = {
  id: string
  handle: string
  name: string
  kind: 'person' | 'organization'
  bio: string
  created: number
  updated: number
  version: number
  members: Map<string, Role>
  invites: Map<string, InviteRec>
  plan?: PlanId
}

export type InviteRec = {
  id: string
  email: string
  role: Role
  secretHash: string
  invitedBy: string
  created: number
  expires: number
}

export type TeamRec = {
  id: string
  org: string
  slug: string
  name: string
  description: string
  members: Set<string>
  repos: Map<string, 'read' | 'write'>
  created: number
  updated: number
  version: number
}

export type FileStat = { hash: string; add: number; del: number }
export type ViaRec = Receipt
export type PatchSetRec = {
  n: number
  sha: string
  tree: string
  note: string
  author: ActorRec
  created: number
  files: Record<string, FileStat>
  kind: 'initial' | 'update' | 'rebase'
  contents?: Record<string, string | null>
  via?: ViaRec
}
export type SuggestionRec = {
  summary: string
  file: string
  replace: Array<string>
  after: string | null
  lines: Array<string>
}
export type TestCaseRec = {
  suite: string
  name: string
  ms: number
  base: 'pass' | 'fail' | 'skip' | 'missing'
  head: 'pass' | 'fail' | 'skip'
}
export type ReviewRec = {
  id: string
  actor: ActorRec
  state: 'approved' | 'commented' | 'changes'
  patchSet: number
  carries: boolean
  body: string
  created: number
  via?: ViaRec
}
export type FindingRec = {
  id: string
  label: string
  by: string
  severity: 'high' | 'medium' | 'low'
  state: 'open' | 'resolved' | 'dismissed'
  reason: string | null
  file: string
  line: number
  title: string
  body: string
  patchSet: number
  created: number
  suggestion?: SuggestionRec
  prompt?: string
  via?: ViaRec
}
export type CheckRec = {
  id: string
  key: string
  name: string
  state: 'pending' | 'pass' | 'fail'
  tree: string
  detailsUrl: string | null
  created: number
  updated: number
  cases?: Array<TestCaseRec>
}
export type ChangeRec = {
  id: string
  number: number
  title: string
  description: string
  state: 'draft' | 'open' | 'landed' | 'abandoned'
  abandonedFrom?: 'draft' | 'open'
  author: ActorRec
  base: string
  branch: string
  patchSets: Array<PatchSetRec>
  reviews: Array<ReviewRec>
  findings: Array<FindingRec>
  checks: Array<CheckRec>
  stackId: string | null
  labels: Array<string>
  mirrors: Array<{ host: string; number: number; origin: 'here' | 'there' }>
  evidence?: Array<EvidenceRec>
  comments?: Array<ReviewCommentRec>
  guide?: GuideRec
  commentRev?: number
  baseFiles?: Record<string, string | null>
  policyMemo?: {
    version: number
    rev?: number
    reqs: Array<z.infer<typeof S.Requirement>>
  }
  latest?: { map: Map<string, ReviewRec>; seen: number }
  created: number
  updated: number
  landed: number | null
  version: number
}
export type GuideRec = {
  patchSet: number
  summary: string
  order: Array<{ path: string; why: string; risk: 'low' | 'medium' | 'high' }>
  by: ActorRec
  via?: ViaRec | null
  created: number
}
export type ReviewCommentRec = {
  id: string
  author: ActorRec
  body: string
  file: string | null
  line: number | null
  patchSet: number
  replyTo: string | null
  resolved: boolean
  created: number
  updated: number
  version: number
  anchor?: Anchor | null
  placements?: Record<string, Placement>
  addressed?: Addressed | null
  via?: ViaRec
}
export type EvidenceRec = {
  id: string
  kind: 'image' | 'recording' | 'preview' | 'test_results'
  caption: string
  uploadId: string
  by: ActorRec
  created: number
}
export type IssueRec = {
  id: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author: ActorRec
  labels: Array<string>
  assignees?: Array<ActorRec>
  closedAs?: 'completed' | 'not_planned' | 'duplicate' | null
  comments?: Array<CommentRec>
  evidence?: Array<EvidenceRec>
  created: number
  updated: number
  closed: number | null
  version: number
}
export type CommentRec = {
  id: string
  author: ActorRec
  body: string
  created: number
  updated: number
  version: number
}
export type LabelColor =
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
export type LabelRec = {
  id: string
  name: string
  color: LabelColor
  description: string
  created: number
}
export type OperationRec = {
  id: string
  kind: string
  repoId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  done: number
  total: number
  result: { object: string; id: string; url: string } | null
  error: Record<string, unknown> | null
  created: number
  finished: number | null
  steps?: Array<LandingStepRec>
}

export type RepoCategory = (typeof S.repoCategories)[number]

export type RepoRec = {
  id: string
  storeId: string
  owner: string
  name: string
  description: string
  visibility: 'public' | 'private'
  defaultBranch: string
  stars: number
  starredBy: Set<string>
  starTimes: Array<number>
  starsTodayBase: number
  forks: number
  upstream: {
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea'
    slug: string
  } | null
  install: string | null
  sampleCommitFacts?: (sha: string) => {
    change: number | null
    checks: 'pass' | 'fail' | null
  }
  category: RepoCategory | null
  languages: Array<[name: string, percent: number]>
  license: string | null
  website: string | null
  docsUrl: string | null
  declinedModels?: Array<string>
  autoLand?: { by: string } | null
  vouched?: Array<string>
  denounced?: Array<{ handle: string; reason: string }>
  created: number
  updated: number
  version: number
  rev: number
  changeRev: number
  issueRev: number
  nextNumber: number
  collaborators: Set<string>
  maintainers: Set<string>
  maintainerGrants: Set<string>
  changes: Map<number, ChangeRec>
  issues: Map<number, IssueRec>
  releases?: Array<ReleaseRec>
  pipelines?: Array<PipelineRunRec>
  ruleModes?: Map<string, RuleMode>
  policyExceptions?: Array<PolicyExceptionRec>
  customRules?: Array<CustomRuleRec>
  policyRev?: number
  policyFile?: {
    text: string
    sha: string
    errors: Array<FileError>
    at: number
  }
  landing?: Landing
  triggers?: {
    files: Record<string, string>
    sha: string
    set: Array<Trigger>
    errors: Array<TriggerFileError>
    rev: number
  }
  triggerRuns?: Map<string, TriggerRunRec>
  accessRules?: Array<AccessRule>
  labels: Map<string, LabelRec>
  labelRev: number
  stacks: Map<string, Array<number>>
  byUpdated: Sorted<ChangeRec>
  byNumber: Sorted<ChangeRec>
  issuesByNumber: Sorted<IssueRec>
  openIssueByTitle: Map<string, IssueRec>
  openChangeByBranch: Map<string, ChangeRec>
  counts: { key: string; openChanges: number; openIssues: number }
  env: Array<{ name: string; kind: string; set: Array<string> }>
}

export class Sorted<T> {
  readonly items: Array<T> = []
  constructor(
    private readonly key: (t: T) => number,
    private readonly id: (t: T) => string,
  ) {}

  private cmp(a: T, b: T) {
    const d = this.key(a) - this.key(b)
    if (d !== 0) return d
    const x = this.id(a)
    const y = this.id(b)
    return x < y ? -1 : x > y ? 1 : 0
  }

  private lower(t: T) {
    let lo = 0
    let hi = this.items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.cmp(this.items[mid], t) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  add(t: T) {
    const n = this.items.length
    if (n === 0 || this.cmp(this.items[n - 1], t) < 0) this.items.push(t)
    else this.items.splice(this.lower(t), 0, t)
  }

  remove(t: T) {
    const i = this.lower(t)
    if (this.items[i] === t) this.items.splice(i, 1)
  }
}

export const changeUpdated = (c: ChangeRec) => c.updated
export const changeNumber = (c: ChangeRec) => c.number
export const issueNumber = (i: IssueRec) => i.number
export const recId = (r: { id: string }) => r.id
export const seqId = (e: { sequence: number }) => String(e.sequence)

let isoMs = Number.NaN
let isoText = ''
export const iso = (ms: number) => {
  if (ms !== isoMs) {
    isoText = new Date(ms).toISOString()
    isoMs = ms
  }
  return isoText
}

export type Assume = {
  approve?: Array<string>
  checks?: Record<string, 'pending' | 'pass' | 'fail'>
  resolve?: Array<string>
}
export type Requirement = z.infer<typeof S.Requirement>
export type PolicyState = 'met' | 'blocked' | 'pending'

export type Viewer = Principal | null

export type Attached = {
  auth: TokenService
  hooks: HookPort
  search: SearchIndex
  uploads: UploadPort
  extras: ExtrasPort
  secrets: Promise<SecretBox | null>
  git: GitData
  mail: Mailer
  github?: Github | null
  providers?: ProviderSync | null
  health?: Health
}

export type NotificationKind =
  | 'handoff'
  | 'review'
  | 'mention'
  | 'release'
  | 'ci'
  | 'issue'
  | 'import'
export type NotificationRec = {
  id: string
  kind: NotificationKind
  title: string
  repo: string | null
  path: string
  unread: boolean
  created: number
}
export type NotificationPrefs = Record<NotificationKind, boolean> & {
  digest: boolean
}

export type ReleaseChannel = 'stable' | 'beta' | 'nightly'
export type AssetRec = {
  name: string
  platform: 'macos' | 'windows' | 'linux'
  arch: string
  size: number
  downloads: number
  sha256: string
  uploadId?: string
  /** Where the file is kept when it is not stored here. */
  sourceUrl?: string
}
export type ReleaseRec = {
  id: string
  tag: string
  channel: ReleaseChannel
  title: string
  notes: { added: Array<string>; changed: Array<string>; fixed: Array<string> }
  /** The notes as written, when they came from a provider. */
  body?: string
  signed: boolean
  commit: string | null
  withdrawn: { reason: string; at: number } | null
  assets: Array<AssetRec>
  author: ActorRec
  published: number
  version: number
}

export type { PipelineStatus } from '../lifecycles'
import type { PipelineStatus, PipelineWait } from '../lifecycles'
export type LogLevel = 'cmd' | 'info' | 'dim' | 'ok' | 'warn' | 'error'
export type TriggerRunRec = {
  triggerId: string
  eventSequence: number
  runId: string | null
  run: number | null
  state: 'started' | 'failed' | 'capped'
  error: string | null
  at: number
}

export type RunnerRec = {
  id: string
  account: string
  name: string
  kind: 'self-hosted' | 'hosted'
  provider: string | null
  labels: Array<string>
  repos: Array<string> | null
  concurrency: number
  disabled: boolean
  lastSeen: number | null
  createdBy: string
  created: number
  tokenId: string
}

export type PipelineRunRec = {
  id: string
  number: number
  workflow: string
  title: string
  branch: string
  sha: string
  status: PipelineStatus
  trigger: 'push' | 'change' | 'tag' | 'schedule' | 'manual' | 'event'
  runsOnPending?: boolean
  runsOnFrom?: number
  actor: string
  started: number
  finished: number | null
  file: string
  annotations: Array<{
    level: 'error' | 'warn'
    text: string
    job: string
    step: string
  }>
  jobs: Array<{
    name: string
    runner: string
    status: PipelineStatus | 'skipped'
    duration: number
    runsOn?: Array<string>
    /** Names of the jobs this one waits for (GitHub Actions `needs`). */
    needs?: Array<string>
    runnerId?: string | null
    lease?: number | null
    steps: Array<{
      name: string
      status: PipelineStatus | 'skipped'
      duration: number
      lines: Array<{ t: string; level: LogLevel | null }>
      wait?: PipelineWait | null
    }>
  }>
  version: number
}

export type RuleMode = 'enforce' | 'dry-run' | 'off'
export type PolicyExceptionRec = {
  id: string
  rule: string
  who: string
  reason: string
  createdBy: string
  created: number
  expires: number
}

export type CustomRuleRec = {
  id: string
  name: string
  kind: 'required_check' | 'path_approval' | 'max_lines' | 'allowed_paths'
  check?: string
  paths?: Array<string>
  approvals?: number
  from?: Array<string>
  maxLines?: number
  createdBy: string
  created: number
}
