import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const role = v.union(
  v.literal('owner'),
  v.literal('admin'),
  v.literal('member'),
)

const legacyClass = v.optional(
  v.union(v.literal('human'), v.literal('agent'), v.literal('bot')),
)

export const viaRef = v.object({
  machine: v.union(v.null(), v.string()),
  tool: v.union(v.null(), v.string()),
  model: v.union(v.null(), v.string()),
})

export const provider = v.union(
  v.literal('github'),
  v.literal('gitlab'),
  v.literal('codeberg'),
)

export const actorRef = v.object({
  id: v.string(),
  handle: v.string(),
  class: legacyClass,
})

export default defineSchema({
  accounts: defineTable({
    kind: v.union(v.literal('person'), v.literal('organization')),
    handle: v.string(),
    name: v.string(),
    bio: v.string(),
    now: v.optional(v.string()),
    setup: v.optional(
      v.object({
        agents: v.array(v.string()),
        models: v.array(v.string()),
        tools: v.array(v.string()),
      }),
    ),
    authId: v.optional(v.string()),
    publicId: v.string(),
    created: v.number(),
    updated: v.number(),
    version: v.number(),
    aclRev: v.number(),
    deletionRequested: v.optional(v.number()),
    purgeAt: v.optional(v.number()),
  })
    .index('by_handle', ['handle'])
    .index('by_authId', ['authId'])
    .index('by_publicId', ['publicId'])
    .index('by_purgeAt', ['purgeAt']),

  subscriptions: defineTable({
    accountId: v.id('accounts'),
    plan: v.union(v.literal('solo'), v.literal('team'), v.literal('business')),
    status: v.union(v.literal('active'), v.literal('lapsed')),
    seats: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    lapsedAt: v.optional(v.number()),
    provider: v.optional(v.string()),
    providerRef: v.optional(v.string()),
    eventAt: v.optional(v.number()),
    updated: v.number(),
  }).index('by_accountId', ['accountId']),

  planGrants: defineTable({
    accountId: v.id('accounts'),
    plan: v.union(v.literal('solo'), v.literal('team'), v.literal('business')),
    reason: v.string(),
    grantedBy: v.string(),
    created: v.number(),
    expires: v.optional(v.number()),
    revoked: v.optional(v.number()),
  }).index('by_accountId', ['accountId']),

  retiredHandles: defineTable({ hash: v.string(), retired: v.number() }).index(
    'by_hash',
    ['hash'],
  ),

  repoSizes: defineTable({
    repoId: v.id('repos'),
    storeId: v.string(),
    bytes: v.number(),
    measured: v.number(),
    stale: v.boolean(),
  })
    .index('by_repoId', ['repoId'])
    .index('by_storeId', ['storeId'])
    .index('by_stale_and_measured', ['stale', 'measured']),

  accountUsage: defineTable({
    accountId: v.id('accounts'),
    month: v.string(),
    transferBytes: v.number(),
    pushBytes: v.number(),
  }).index('by_accountId_and_month', ['accountId', 'month']),

  sweeps: defineTable({
    kind: v.union(v.literal('git'), v.literal('blob'), v.literal('provider')),
    key: v.string(),
    created: v.number(),
    lease: v.number(),
  }).index('by_kind_and_lease', ['kind', 'lease']),

  actors: defineTable({
    key: v.string(),
    publicId: v.string(),
    handle: v.string(),
    class: legacyClass,
  }).index('by_key', ['key']),

  memberships: defineTable({
    organizationId: v.id('accounts'),
    personId: v.id('accounts'),
    role,
  })
    .index('by_organizationId_and_personId', ['organizationId', 'personId'])
    .index('by_personId', ['personId']),

  invitations: defineTable({
    publicId: v.string(),
    organizationId: v.id('accounts'),
    email: v.string(),
    role,
    secretHash: v.string(),
    invitedBy: v.string(),
    created: v.number(),
    expires: v.number(),
  })
    .index('by_organizationId_and_email', ['organizationId', 'email'])
    .index('by_organizationId_and_created', ['organizationId', 'created'])
    .index('by_secretHash', ['secretHash'])
    .index('by_publicId', ['publicId']),

  handleAliases: defineTable({
    handle: v.string(),
    accountId: v.id('accounts'),
  }).index('by_handle', ['handle']),

  repos: defineTable({
    publicId: v.string(),
    storeId: v.string(),
    ownerId: v.id('accounts'),
    owner: v.string(),
    name: v.string(),
    key: v.string(),
    description: v.string(),
    visibility: v.union(v.literal('public'), v.literal('private')),
    defaultBranch: v.string(),
    stars: v.number(),
    starsTodayBase: v.number(),
    forks: v.number(),
    upstream: v.union(
      v.null(),
      v.object({
        host: v.union(
          v.literal('github'),
          v.literal('gitlab'),
          v.literal('codeberg'),
          v.literal('gitea'),
        ),
        slug: v.string(),
      }),
    ),
    install: v.union(v.null(), v.string()),
    category: v.union(v.null(), v.string()),
    languages: v.array(v.array(v.union(v.string(), v.number()))),
    license: v.union(v.null(), v.string()),
    website: v.union(v.null(), v.string()),
    docsUrl: v.union(v.null(), v.string()),
    collaborators: v.array(v.string()),
    installs: v.optional(v.array(v.string())),
    maintainers: v.array(v.string()),
    maintainerGrants: v.array(v.string()),
    env: v.array(
      v.object({
        name: v.string(),
        kind: v.string(),
        set: v.array(v.string()),
      }),
    ),
    sampleFacts: v.optional(v.boolean()),
    transcripts: v.optional(v.union(v.literal('off'), v.literal('on'))),
    runTrailer: v.optional(
      v.union(v.literal('auto'), v.literal('on'), v.literal('off')),
    ),
    declinedModels: v.optional(v.array(v.string())),
    autoLand: v.optional(v.union(v.null(), v.object({ by: v.string() }))),
    ownerSince: v.optional(v.number()),
    vouched: v.optional(v.array(v.string())),
    denounced: v.optional(
      v.array(v.object({ handle: v.string(), reason: v.string() })),
    ),
    created: v.number(),
    updated: v.number(),
    version: v.number(),
    aclRev: v.number(),
  })
    .index('by_key', ['key'])
    .index('by_ownerId_and_name', ['ownerId', 'name'])
    .index('by_publicId', ['publicId'])
    .index('by_storeId', ['storeId'])
    .index('by_owner_and_created_and_publicId', [
      'owner',
      'created',
      'publicId',
    ])
    .index('by_created_and_publicId', ['created', 'publicId'])
    .index('by_updated', ['updated']),

  repoCounters: defineTable({
    repoId: v.id('repos'),
    nextNumber: v.number(),
    seq: v.number(),
    rev: v.number(),
    changeRev: v.number(),
    issueRev: v.number(),
    labelRev: v.number(),
    policyRev: v.number(),
    openChanges: v.number(),
    openIssues: v.number(),
    pipelines: v.optional(v.number()),
    pipelineNumber: v.optional(v.number()),
    pipelineRev: v.optional(v.number()),
    automationRev: v.optional(v.number()),
    triggersRev: v.optional(v.number()),
  }).index('by_repoId', ['repoId']),

  repoAliases: defineTable({
    from: v.string(),
    to: v.string(),
  })
    .index('by_from', ['from'])
    .index('by_to', ['to']),

  deletedRepos: defineTable({
    publicId: v.string(),
    full: v.string(),
    key: v.string(),
    owner: v.string(),
    deleted: v.number(),
  })
    .index('by_publicId', ['publicId'])
    .index('by_full', ['full'])
    .index('by_key', ['key']),

  stars: defineTable({
    repoId: v.id('repos'),
    handle: v.string(),
    at: v.number(),
  })
    .index('by_repoId_and_handle', ['repoId', 'handle'])
    .index('by_repoId_and_at', ['repoId', 'at'])
    .index('by_handle', ['handle']),

  teams: defineTable({
    publicId: v.string(),
    organizationId: v.id('accounts'),
    org: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    created: v.number(),
    updated: v.number(),
    version: v.number(),
  })
    .index('by_org_and_slug', ['org', 'slug'])
    .index('by_organizationId', ['organizationId']),

  teamMembers: defineTable({
    teamId: v.id('teams'),
    handle: v.string(),
  })
    .index('by_teamId_and_handle', ['teamId', 'handle'])
    .index('by_handle', ['handle']),

  teamRepos: defineTable({
    teamId: v.id('teams'),
    repoId: v.id('repos'),
    level: v.union(v.literal('read'), v.literal('write')),
  })
    .index('by_teamId_and_repoId', ['teamId', 'repoId'])
    .index('by_repoId', ['repoId']),

  forgeEvents: defineTable({
    stream: v.string(),
    seq: v.number(),
    type: v.string(),
    repo: v.union(v.null(), v.string()),
    repoId: v.union(v.null(), v.string()),
    created: v.number(),
    json: v.string(),
    sequence: v.union(v.null(), v.number()),
  })
    .index('by_stream_and_seq', ['stream', 'seq'])
    .index('by_sequence', ['sequence'])
    .index('by_created', ['created']),

  stateChanges: defineTable({
    repoId: v.id('repos'),
    subject: v.string(),
    to: v.string(),
    at: v.number(),
    eventId: v.string(),
    actor: actorRef,
    via: v.optional(viaRef),
  }).index('by_repoId_and_subject_and_at', ['repoId', 'subject', 'at']),

  issueRefs: defineTable({
    repoId: v.id('repos'),
    issue: v.number(),
    changeId: v.id('changes'),
    closes: v.boolean(),
  })
    .index('by_repoId_and_issue', ['repoId', 'issue'])
    .index('by_changeId', ['changeId']),

  eventHead: defineTable({ head: v.number() }),

  accessRevision: defineTable({ rev: v.number() }),

  labels: defineTable({
    repoId: v.id('repos'),
    publicId: v.string(),
    name: v.string(),
    key: v.string(),
    color: v.string(),
    description: v.string(),
    created: v.number(),
    openIssues: v.number(),
  }).index('by_repoId_and_key', ['repoId', 'key']),

  issues: defineTable({
    repoId: v.id('repos'),
    publicId: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    text: v.string(),
    state: v.union(v.literal('open'), v.literal('closed')),
    author: actorRef,
    labels: v.array(v.string()),
    assignees: v.array(actorRef),
    /** Why it was closed, when that was said (imported from a provider). */
    closedAs: v.optional(
      v.union(
        v.literal('completed'),
        v.literal('not_planned'),
        v.literal('duplicate'),
      ),
    ),
    commentCount: v.number(),
    created: v.number(),
    updated: v.number(),
    closed: v.union(v.null(), v.number()),
    version: v.number(),
  })
    .index('by_repoId_and_number', ['repoId', 'number'])
    .index('by_repoId_and_state_and_number', ['repoId', 'state', 'number'])
    .index('by_repoId_and_title', ['repoId', 'title'])
    .index('by_publicId', ['publicId'])
    .searchIndex('search_text', {
      searchField: 'text',
      filterFields: ['repoId', 'state'],
    }),

  issueComments: defineTable({
    issueId: v.id('issues'),
    repoId: v.id('repos'),
    publicId: v.string(),
    author: actorRef,
    body: v.string(),
    created: v.number(),
    updated: v.number(),
    version: v.number(),
  })
    .index('by_issueId', ['issueId'])
    .index('by_repoId_and_publicId', ['repoId', 'publicId']),

  issueEvidence: defineTable({
    issueId: v.id('issues'),
    publicId: v.string(),
    kind: v.union(v.literal('image'), v.literal('recording')),
    caption: v.string(),
    upload: v.object({
      id: v.string(),
      contentType: v.string(),
      size: v.number(),
      sha256: v.string(),
    }),
    by: actorRef,
    created: v.number(),
  }).index('by_issueId', ['issueId']),

  changes: defineTable({
    repoId: v.id('repos'),
    publicId: v.string(),
    number: v.number(),
    title: v.string(),
    description: v.string(),
    text: v.string(),
    state: v.union(
      v.literal('draft'),
      v.literal('open'),
      v.literal('landed'),
      v.literal('abandoned'),
    ),
    abandonedFrom: v.optional(v.union(v.literal('draft'), v.literal('open'))),
    author: actorRef,
    base: v.string(),
    branch: v.string(),
    stackId: v.union(v.null(), v.string()),
    labels: v.array(v.string()),
    mirrors: v.array(
      v.object({
        host: v.string(),
        number: v.number(),
        origin: v.union(v.literal('here'), v.literal('there')),
      }),
    ),
    baseFiles: v.optional(v.string()),
    commentRev: v.number(),
    headSha: v.string(),
    created: v.number(),
    updated: v.number(),
    landed: v.union(v.null(), v.number()),
    version: v.number(),
  })
    .index('by_repoId_and_number', ['repoId', 'number'])
    .index('by_repoId_and_headSha', ['repoId', 'headSha'])
    .index('by_repoId_and_updated_and_publicId', [
      'repoId',
      'updated',
      'publicId',
    ])
    .index('by_repoId_and_branch', ['repoId', 'branch'])
    .index('by_repoId_and_stackId', ['repoId', 'stackId'])
    .index('by_publicId', ['publicId'])
    .searchIndex('search_text', {
      searchField: 'text',
      filterFields: ['repoId', 'state'],
    }),

  changeParts: defineTable({
    changeId: v.id('changes'),
    kind: v.union(
      v.literal('patchSet'),
      v.literal('review'),
      v.literal('finding'),
      v.literal('check'),
      v.literal('comment'),
      v.literal('evidence'),
      v.literal('guide'),
    ),
    key: v.string(),
    seq: v.number(),
    json: v.string(),
  }).index('by_changeId_and_kind_and_seq', ['changeId', 'kind', 'seq']),

  reviewSeen: defineTable({
    changeId: v.id('changes'),
    handle: v.string(),
    path: v.string(),
    patchSet: v.number(),
    contentHash: v.string(),
  }).index('by_changeId_and_handle_and_path', ['changeId', 'handle', 'path']),

  presenceRooms: defineTable({
    room: v.string(),
    token: v.string(),
  }).index('by_room', ['room']),

  repoPolicy: defineTable({
    repoId: v.id('repos'),
    ruleModes: v.array(v.object({ id: v.string(), mode: v.string() })),
    customRules: v.string(),
    exceptions: v.string(),
    landing: v.optional(v.string()),
    sourceSha: v.optional(v.string()),
    sourceText: v.optional(v.string()),
    errors: v.optional(v.string()),
  }).index('by_repoId', ['repoId']),

  repoAccessRules: defineTable({
    repoId: v.id('repos'),
    ruleId: v.string(),
    kind: v.union(v.literal('branch'), v.literal('path')),
    patterns: v.array(v.string()),
    readers: v.array(v.string()),
    createdBy: v.string(),
    created: v.number(),
  }).index('by_repoId_and_ruleId', ['repoId', 'ruleId']),

  repoTriggers: defineTable({
    repoId: v.id('repos'),
    sourceText: v.string(),
    sourceSha: v.string(),
    triggersJson: v.string(),
    errors: v.string(),
    rev: v.number(),
  }).index('by_repoId', ['repoId']),

  triggerRuns: defineTable({
    repoId: v.id('repos'),
    triggerId: v.string(),
    eventSequence: v.number(),
    runId: v.union(v.null(), v.string()),
    run: v.union(v.null(), v.number()),
    state: v.union(
      v.literal('started'),
      v.literal('failed'),
      v.literal('capped'),
    ),
    error: v.union(v.null(), v.string()),
    at: v.number(),
  })
    .index('by_repoId_and_triggerId_and_eventSequence', [
      'repoId',
      'triggerId',
      'eventSequence',
    ])
    .index('by_repoId_and_at', ['repoId', 'at']),

  operations: defineTable({
    publicId: v.string(),
    kind: v.string(),
    repoId: v.string(),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('succeeded'),
      v.literal('failed'),
      v.literal('canceled'),
    ),
    done: v.number(),
    total: v.number(),
    result: v.union(
      v.null(),
      v.object({ object: v.string(), id: v.string(), url: v.string() }),
    ),
    error: v.union(v.null(), v.string()),
    created: v.number(),
    finished: v.union(v.null(), v.number()),
    steps: v.optional(v.string()),
    pending: v.optional(
      v.object({ object: v.string(), id: v.string(), url: v.string() }),
    ),
  })
    .index('by_publicId', ['publicId'])
    .index('by_finished', ['finished']),

  pipelineRuns: defineTable({
    repoId: v.id('repos'),
    publicId: v.string(),
    number: v.number(),
    workflow: v.string(),
    status: v.string(),
    started: v.number(),
    json: v.string(),
  })
    .index('by_repoId_and_started', ['repoId', 'started'])
    .index('by_repoId_and_number', ['repoId', 'number'])
    .index('by_repoId_and_status_and_started', ['repoId', 'status', 'started'])
    .index('by_status_and_started', ['status', 'started']),

  runners: defineTable({
    publicId: v.string(),
    account: v.string(),
    name: v.string(),
    kind: v.union(v.literal('self-hosted'), v.literal('hosted')),
    provider: v.union(v.null(), v.string()),
    labels: v.array(v.string()),
    repos: v.union(v.null(), v.array(v.string())),
    concurrency: v.number(),
    status: v.union(v.literal('active'), v.literal('disabled')),
    createdBy: v.string(),
    created: v.number(),
    tokenId: v.string(),
  })
    .index('by_account_and_name', ['account', 'name'])
    .index('by_publicId', ['publicId']),

  runnerSeen: defineTable({
    runnerId: v.id('runners'),
    at: v.number(),
  }).index('by_runnerId', ['runnerId']),

  pipelineLogs: defineTable({
    runId: v.id('pipelineRuns'),
    job: v.number(),
    step: v.number(),
    lines: v.string(),
    count: v.number(),
  }).index('by_runId_and_job_and_step', ['runId', 'job', 'step']),

  releases: defineTable({
    repoId: v.id('repos'),
    publicId: v.string(),
    tag: v.string(),
    channel: v.string(),
    published: v.number(),
    json: v.string(),
    version: v.number(),
  })
    .index('by_repoId_and_published', ['repoId', 'published'])
    .index('by_repoId_and_tag', ['repoId', 'tag']),

  downloads: defineTable({
    releaseId: v.id('releases'),
    asset: v.string(),
    shard: v.number(),
    n: v.number(),
  }).index('by_releaseId_and_asset_and_shard', ['releaseId', 'asset', 'shard']),

  connections: defineTable({
    account: v.string(),
    integration: v.string(),
    hint: v.union(v.null(), v.string()),
    keyHash: v.union(v.null(), v.string()),
    by: v.string(),
    connected: v.number(),
  }).index('by_account_and_integration', ['account', 'integration']),

  repoIntegrations: defineTable({
    repoId: v.id('repos'),
    integration: v.string(),
  }).index('by_repoId_and_integration', ['repoId', 'integration']),

  links: defineTable({
    handle: v.string(),
    host: v.string(),
    login: v.string(),
    instance: v.union(v.null(), v.string()),
    linked: v.number(),
    verified: v.optional(v.boolean()),
  })
    .index('by_handle_and_host', ['handle', 'host'])
    .index('by_host_and_login', ['host', 'login']),

  githubLinks: defineTable({
    githubId: v.number(),
    slug: v.string(),
    repoId: v.id('repos'),
    by: v.string(),
    at: v.number(),
  })
    .index('by_githubId', ['githubId'])
    .index('by_repoId', ['repoId']),

  providerConnections: defineTable({
    handle: v.string(),
    provider: provider,
    instance: v.string(),
    externalId: v.string(),
    login: v.string(),
    token: v.union(v.null(), v.string()),
    refresh: v.union(v.null(), v.string()),
    keyId: v.union(v.null(), v.string()),
    expiresAt: v.union(v.null(), v.number()),
    scopes: v.array(v.string()),
    state: v.union(v.literal('ok'), v.literal('needs_reconnect')),
    problem: v.union(v.null(), v.string()),
    refreshLease: v.union(v.null(), v.number()),
    created: v.number(),
    updated: v.number(),
  })
    .index('by_handle_and_provider_and_instance', [
      'handle',
      'provider',
      'instance',
    ])
    .index('by_provider_and_instance_and_externalId', [
      'provider',
      'instance',
      'externalId',
    ])
    .index('by_state_and_expiresAt', ['state', 'expiresAt']),

  remoteRepos: defineTable({
    provider: provider,
    instance: v.string(),
    externalId: v.string(),
    fullName: v.string(),
    repoId: v.id('repos'),
    connectionId: v.union(v.null(), v.id('providerConnections')),
    by: v.string(),
    state: v.union(
      v.literal('syncing'),
      v.literal('linked'),
      v.literal('delayed'),
      v.literal('broken'),
      v.literal('archived'),
      v.literal('gone'),
    ),
    problem: v.union(v.null(), v.string()),
    installation: v.union(v.null(), v.number()),
    webhookId: v.union(v.null(), v.string()),
    credentialId: v.union(v.null(), v.string()),
    lfs: v.boolean(),
    meta: v.object({
      private: v.boolean(),
      archived: v.boolean(),
      defaultBranch: v.string(),
      description: v.string(),
      stars: v.number(),
      forks: v.number(),
      license: v.union(v.null(), v.string()),
      website: v.union(v.null(), v.string()),
    }),
    lastPull: v.number(),
    lastSync: v.union(v.null(), v.number()),
    etags: v.optional(v.record(v.string(), v.string())),
    importedAt: v.optional(v.number()),
    itemsDue: v.optional(v.number()),
    at: v.number(),
  })
    .index('by_provider_and_instance_and_externalId', [
      'provider',
      'instance',
      'externalId',
    ])
    .index('by_repoId', ['repoId'])
    .index('by_connectionId', ['connectionId'])
    .index('by_installation', ['installation'])
    .index('by_lastPull', ['lastPull'])
    .index('by_itemsDue', ['itemsDue']),

  remoteItems: defineTable({
    repoId: v.id('repos'),
    kind: v.union(v.literal('pull'), v.literal('issue'), v.literal('release')),
    number: v.number(),
    key: v.string(),
    title: v.string(),
    body: v.string(),
    state: v.string(),
    authorId: v.union(v.null(), v.id('externalActors')),
    labels: v.array(v.string()),
    url: v.string(),
    created: v.number(),
    updated: v.number(),
    closed: v.union(v.null(), v.number()),
    merged: v.union(v.null(), v.number()),
    head: v.optional(
      v.object({
        ref: v.string(),
        sha: v.string(),
        base: v.string(),
        fromFork: v.boolean(),
        commitsHere: v.union(v.null(), v.boolean()),
      }),
    ),
    flags: v.optional(
      v.object({ draft: v.boolean(), prerelease: v.boolean() }),
    ),
    hasPatch: v.boolean(),
    comments: v.number(),
    removed: v.union(
      v.null(),
      v.object({
        at: v.number(),
        byId: v.union(v.null(), v.id('externalActors')),
      }),
    ),
  })
    .index('by_repoId_and_kind_and_key', ['repoId', 'kind', 'key'])
    .index('by_repoId_and_kind_and_updated', ['repoId', 'kind', 'updated']),

  remoteComments: defineTable({
    itemId: v.id('remoteItems'),
    externalId: v.string(),
    body: v.string(),
    authorId: v.union(v.null(), v.id('externalActors')),
    created: v.number(),
    updated: v.number(),
    removed: v.union(v.null(), v.number()),
  }).index('by_itemId_and_externalId', ['itemId', 'externalId']),

  remotePatches: defineTable({
    itemId: v.id('remoteItems'),
    text: v.string(),
    truncated: v.boolean(),
  }).index('by_itemId', ['itemId']),

  externalActors: defineTable({
    provider: provider,
    instance: v.string(),
    externalId: v.string(),
    login: v.string(),
    name: v.union(v.null(), v.string()),
    avatar: v.union(v.null(), v.string()),
    deleted: v.boolean(),
    updated: v.number(),
  }).index('by_provider_and_instance_and_externalId', [
    'provider',
    'instance',
    'externalId',
  ]),

  importJobs: defineTable({
    handle: v.string(),
    owner: v.string(),
    provider: provider,
    instance: v.string(),
    connectionId: v.union(v.null(), v.id('providerConnections')),
    state: v.union(
      v.literal('running'),
      v.literal('done'),
      v.literal('cancelled'),
    ),
    total: v.number(),
    done: v.number(),
    failed: v.number(),
    created: v.number(),
    updated: v.number(),
  }).index('by_handle_and_created', ['handle', 'created']),

  importItems: defineTable({
    jobId: v.id('importJobs'),
    externalId: v.string(),
    slug: v.string(),
    name: v.string(),
    visibility: v.union(v.literal('public'), v.literal('private')),
    defaultBranch: v.string(),
    installation: v.union(v.null(), v.number()),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('done'),
      v.literal('failed'),
      v.literal('skipped'),
    ),
    attempts: v.number(),
    lease: v.number(),
    error: v.union(v.null(), v.string()),
    repo: v.union(v.null(), v.string()),
    updated: v.number(),
  })
    .index('by_jobId', ['jobId'])
    .index('by_state_and_lease', ['state', 'lease']),

  hookDeliveries: defineTable({
    provider: provider,
    deliveryId: v.string(),
    at: v.number(),
  })
    .index('by_provider_and_deliveryId', ['provider', 'deliveryId'])
    .index('by_at', ['at']),

  providerAudit: defineTable({
    handle: v.string(),
    provider: provider,
    action: v.union(
      v.literal('connected'),
      v.literal('reconnected'),
      v.literal('disconnected'),
      v.literal('imported'),
      v.literal('adopted'),
      v.literal('unlinked'),
      v.literal('relinked'),
      v.literal('published'),
      v.literal('needs_reconnect'),
    ),
    repo: v.union(v.null(), v.string()),
    detail: v.union(v.null(), v.string()),
    at: v.number(),
  })
    .index('by_handle_and_at', ['handle', 'at'])
    .index('by_repo_and_at', ['repo', 'at']),

  integrationRev: defineTable({ account: v.string(), rev: v.number() }).index(
    'by_account',
    ['account'],
  ),

  accountPrefs: defineTable({ handle: v.string(), prefs: v.string() }).index(
    'by_handle',
    ['handle'],
  ),

  follows: defineTable({ who: v.string(), whom: v.string() })
    .index('by_who_and_whom', ['who', 'whom'])
    .index('by_whom_and_who', ['whom', 'who']),

  peopleStats: defineTable({
    handle: v.string(),
    followers: v.number(),
    following: v.number(),
    rev: v.number(),
  }).index('by_handle', ['handle']),

  contributions: defineTable({
    handle: v.string(),
    kind: v.union(
      v.literal('review'),
      v.literal('change'),
      v.literal('issue'),
      v.literal('release'),
    ),
    at: v.number(),
    title: v.string(),
    repoId: v.id('repos'),
    agent: v.boolean(),
  }).index('by_handle_and_at', ['handle', 'at']),

  peopleRev: defineTable({ rev: v.number() }),

  downloadDays: defineTable({
    repoId: v.id('repos'),
    day: v.number(),
    n: v.number(),
  }).index('by_repoId_and_day', ['repoId', 'day']),

  issueAssignees: defineTable({
    handle: v.string(),
    issueId: v.id('issues'),
    repoId: v.id('repos'),
  })
    .index('by_handle', ['handle'])
    .index('by_issueId', ['issueId']),

  repoGrants: defineTable({ handle: v.string(), repoId: v.id('repos') })
    .index('by_handle', ['handle'])
    .index('by_repoId_and_handle', ['repoId', 'handle']),

  repoExtras: defineTable({
    repoId: v.id('repos'),
    json: v.string(),
    version: v.number(),
  }).index('by_repoId', ['repoId']),

  uploads: defineTable({
    publicId: v.string(),
    owner: v.string(),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
    purpose: v.union(
      v.literal('evidence'),
      v.literal('release'),
      v.literal('transcript'),
    ),
    state: v.union(v.literal('pending'), v.literal('uploaded')),
    sha256: v.union(v.null(), v.string()),
    expires: v.number(),
    created: v.number(),
    attachedTo: v.union(v.null(), v.string()),
    attachedRepoId: v.union(v.null(), v.string()),
  })
    .index('by_publicId', ['publicId'])
    .index('by_owner_and_state', ['owner', 'state'])
    .index('by_attachedRepoId', ['attachedRepoId'])
    .index('by_state_and_expires', ['state', 'expires']),

  webhooks: defineTable({
    publicId: v.string(),
    repoId: v.id('repos'),
    url: v.string(),
    description: v.string(),
    events: v.array(v.string()),
    active: v.boolean(),
    disabledReason: v.union(v.null(), v.string()),
    secrets: v.array(
      v.object({
        value: v.string(),
        createdAt: v.number(),
        expiresAt: v.union(v.null(), v.number()),
      }),
    ),
    failures: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    version: v.number(),
    lastDelivery: v.union(v.null(), v.string()),
    nextSequence: v.number(),
  })
    .index('by_publicId', ['publicId'])
    .index('by_repoId', ['repoId']),

  webhookDeliveries: defineTable({
    publicId: v.string(),
    hookId: v.id('webhooks'),
    sequence: v.number(),
    event: v.string(),
    state: v.union(
      v.literal('pending'),
      v.literal('succeeded'),
      v.literal('failed'),
    ),
    attempts: v.array(
      v.object({
        number: v.number(),
        at: v.number(),
        status: v.union(v.null(), v.number()),
        error: v.union(v.null(), v.string()),
        ms: v.number(),
      }),
    ),
    nextAt: v.union(v.null(), v.number()),
    claimedUntil: v.number(),
    redeliveryOf: v.union(v.null(), v.string()),
    createdAt: v.number(),
  })
    .index('by_publicId', ['publicId'])
    .index('by_hookId_and_sequence', ['hookId', 'sequence'])
    .index('by_state_and_nextAt', ['state', 'nextAt']),

  pushes: defineTable({
    storeId: v.string(),
    ref: v.string(),
    before: v.string(),
    after: v.string(),
    pushedAt: v.number(),
  }).index('by_storeId_and_ref_and_after', ['storeId', 'ref', 'after']),

  notifications: defineTable({
    handle: v.string(),
    publicId: v.string(),
    kind: v.string(),
    title: v.string(),
    repoId: v.union(v.null(), v.string()),
    repo: v.union(v.null(), v.string()),
    path: v.string(),
    unread: v.boolean(),
    created: v.number(),
  })
    .index('by_handle_and_created', ['handle', 'created'])
    .index('by_handle_and_unread', ['handle', 'unread'])
    .index('by_publicId', ['publicId']),

  inboxes: defineTable({
    handle: v.string(),
    rev: v.number(),
    count: v.number(),
    prefs: v.union(v.null(), v.record(v.string(), v.boolean())),
  }).index('by_handle', ['handle']),

  tokens: defineTable({
    publicId: v.string(),
    hash: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal('personal'),
      v.literal('bot'),
      v.literal('run'),
      v.literal('oauth'),
      v.literal('runner'),
    ),
    handle: v.string(),
    actingAs: v.string(),
    class: legacyClass,
    device: v.optional(v.union(v.null(), v.string())),
    scopes: v.array(v.string()),
    repos: v.union(v.null(), v.array(v.string())),
    paths: v.optional(v.union(v.null(), v.array(v.string()))),
    runnerId: v.optional(v.string()),
    audience: v.array(v.union(v.literal('api'), v.literal('mcp'))),
    prefix: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.union(v.null(), v.number()),
    revokedAt: v.union(v.null(), v.number()),
    authorizationId: v.optional(v.string()),
    limitKey: v.optional(v.string()),
    loginId: v.optional(v.string()),
  })
    .index('by_hash', ['hash'])
    .index('by_publicId', ['publicId'])
    .index('by_handle_and_createdAt', ['handle', 'createdAt'])
    .index('by_authorizationId', ['authorizationId'])
    .index('by_expiresAt', ['expiresAt']),

  authorizations: defineTable({
    publicId: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    handle: v.string(),
    scopes: v.array(v.string()),
    audience: v.array(v.union(v.literal('api'), v.literal('mcp'))),
    device: v.optional(v.union(v.null(), v.string())),
    createdAt: v.number(),
    lastUsedAt: v.union(v.null(), v.number()),
    revokedAt: v.union(v.null(), v.number()),
  })
    .index('by_publicId', ['publicId'])
    .index('by_handle_and_createdAt', ['handle', 'createdAt']),

  oauthState: defineTable({
    kind: v.string(),
    key: v.string(),
    value: v.string(),
    expires: v.union(v.null(), v.number()),
  })
    .index('by_kind_and_key', ['kind', 'key'])
    .index('by_expires', ['expires']),

  outbox: defineTable({
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    sender: v.optional(v.literal('team')),
    created: v.number(),
    attempts: v.optional(v.number()),
  }).index('by_created', ['created']),

  apiLimits: defineTable({
    key: v.string(),
    start: v.number(),
    used: v.number(),
  })
    .index('by_key', ['key'])
    .index('by_start', ['start']),

  healthMinutes: defineTable({
    area: v.string(),
    minute: v.number(),
    requests: v.number(),
    errors: v.number(),
    hist: v.array(v.number()),
  })
    .index('by_area_and_minute', ['area', 'minute'])
    .index('by_minute', ['minute']),
  healthDays: defineTable({
    area: v.string(),
    day: v.number(),
    requests: v.number(),
    errors: v.number(),
  })
    .index('by_area_and_day', ['area', 'day'])
    .index('by_day', ['day']),
  tallies: defineTable({
    metric: v.string(),
    period: v.string(),
    shard: v.number(),
    value: v.number(),
  }).index('by_metric_and_period_and_shard', ['metric', 'period', 'shard']),
  tallySeed: defineTable({
    pass: v.optional(
      v.object({
        step: v.number(),
        cursor: v.union(v.string(), v.null()),
        moved: v.number(),
      }),
    ),
  }),
  analyticsOutbox: defineTable({
    event: v.string(),
    who: v.string(),
    at: v.number(),
    props: v.string(),
  }),
  statusCounts: defineTable({
    accounts: v.number(),
    repositories: v.number(),
    changes: v.number(),
    issues: v.number(),
    at: v.number(),
    pass: v.optional(
      v.object({
        table: v.number(),
        cursor: v.union(v.string(), v.null()),
        counts: v.object({
          accounts: v.number(),
          repositories: v.number(),
          changes: v.number(),
          issues: v.number(),
        }),
        moved: v.number(),
      }),
    ),
  }),

  apiIdempotency: defineTable({
    scope: v.string(),
    key: v.string(),
    fingerprint: v.string(),
    expires: v.number(),
    started: v.optional(v.number()),
    lease: v.optional(v.string()),
    effect: v.optional(v.number()),
    response: v.optional(
      v.object({ status: v.number(), headers: v.string(), body: v.string() }),
    ),
  })
    .index('by_scope_and_key', ['scope', 'key'])
    .index('by_expires', ['expires']),
})
