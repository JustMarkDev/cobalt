import type { Suggestion } from '~/lib/suggestions'

export type Author = {
  name: string
  kind: 'human' | 'agent' | 'bot'
  via?: {
    machine: string | null
    tool: string | null
    model: string | null
  } | null
}

export type PatchSet = { n: number; when: string; note: string; tree: string }

export type Finding = {
  id: string
  by: string
  kind: 'reviewer' | 'human'
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number
  title: string
  body: string
  fixedIn?: string
  suggestion?: Suggestion
  prompt?: string
}

export type ChangeItem = {
  id: string
  title: string
  author: Author
  state: 'open' | 'landed' | 'draft' | 'abandoned'
  stack?: { index: number; of: number }
  stackId?: string
  blocking?: number
  patchSets: Array<PatchSet>
  files: number
  additions: number
  deletions: number
  reviewers: Array<{
    name: string
    kind: 'human' | 'agent' | 'reviewer'
    state: 'approved' | 'commented' | 'pending' | 'changes'
  }>
  ci: 'pass' | 'fail' | 'pending'
  when: string
  mirror?: {
    host: 'github' | 'gitlab' | 'codeberg' | 'gitea'
    number: number
    origin: 'here' | 'there'
  }
}

export type FileVersions = Record<string, string>

export type Rule = {
  id: string
  name: string
  mode: 'enforce' | 'dry-run' | 'off'
  when: string
  requires: Array<string>
  evaluated: number
  blocked: number
  note?: string
}

export type EnvName = 'development' | 'preview' | 'production'
export const envNames: Array<EnvName> = ['development', 'preview', 'production']

export type EnvVar = {
  name: string
  type: string
  sensitive: boolean
  description: string
  set: Record<EnvName, boolean>
  required: Array<EnvName>
  rotated: string
  by: string
}

export type AuditEvent = {
  when: string
  who: string
  action: string
  target: string
  kind: 'rotate' | 'grant' | 'revoke' | 'read' | 'reject'
}

export const allScopes = [
  'repo:read',
  'repo:write',
  'issues:read',
  'issues:comment',
  'issues:write',
  'pulls:read',
  'pulls:comment',
  'pulls:write',
  'pulls:merge',
  'secrets:schema',
  'secrets:decrypt',
] as const
export type Scope = (typeof allScopes)[number]

export type Bot = {
  slug: string
  name: string
  description: string
  scopes: Array<Scope>
  installs: Array<string>
  tokens: number
  state: 'ready' | 'provisioning'
}

export type Trigger =
  | 'issue.created'
  | 'change.opened'
  | 'change.updated'
  | 'finding.raised'
  | 'ci.failed'
  | 'bot.mentioned'
  | 'repository.pushed'
  | 'schedule'

export const triggers: Array<Trigger> = [
  'issue.created',
  'change.opened',
  'change.updated',
  'finding.raised',
  'ci.failed',
  'bot.mentioned',
  'repository.pushed',
  'schedule',
]

export type Runtime = 'Claude Code' | 'Codex' | 'OpenCode' | 'Grok Build'
export type Target = 'E2B' | 'T3 Code' | 'boat.dev'
