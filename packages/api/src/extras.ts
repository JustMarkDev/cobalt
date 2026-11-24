import { newId } from './ids'

import type { GrantState } from './lifecycles'

export const ENVIRONMENTS = ['development', 'preview', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export type MirrorRec = {
  id: string
  host: string
  slug: string
  direction: 'push' | 'pull' | 'two-way'
  state: 'in-sync' | 'syncing' | 'behind' | 'failing'
  lastSync: number
  detail: string | null
  created: number
  paused?: boolean
}

export type EnvVarRec = {
  name: string
  kind: string
  secret: boolean
  set: Array<Environment>
  description: string
  required?: Array<Environment>
  rotated?: { at: number; by: string }
}

export type ConfirmationRec = {
  id: string
  environment: Environment
  state: GrantState
  handle: string
  tokenId: string
  device: string
  tool: string | null
  reason: string | null
  expires: number
  created: number
}

export type AuditKind = 'rotate' | 'grant' | 'revoke' | 'read' | 'reject'
export type AuditRec = {
  at: number
  who: string
  action: string
  target?: string
  kind?: AuditKind
}

export const PENDING_MS = 10 * 60_000

export class RepoExtras {
  readonly mirrors: Array<MirrorRec> = []
  readonly env: Array<EnvVarRec> = []
  readonly sealed: Record<string, Partial<Record<Environment, string>>> = {}
  readonly confirmations: Array<ConfirmationRec> = []
  readonly audit: Array<AuditRec> = []

  constructor(private readonly now: () => number) {}

  toJSON() {
    return {
      mirrors: this.mirrors,
      env: this.env,
      sealed: this.sealed,
      confirmations: this.confirmations,
      audit: this.audit,
    }
  }

  static from(
    now: () => number,
    data: Partial<ReturnType<RepoExtras['toJSON']>>,
  ) {
    const x = new RepoExtras(now)
    for (const k of ['mirrors', 'env', 'confirmations', 'audit'] as const) {
      const list = x[k] as Array<unknown>
      list.splice(0, list.length, ...((data[k] ?? []) as Array<unknown>))
    }
    Object.assign(x.sealed, data.sealed ?? {})
    return x
  }

  note(
    who: string,
    action: string,
    more?: { target?: string; kind?: AuditKind },
  ) {
    this.audit.unshift({ at: this.now(), who, action, ...more })
    if (this.audit.length > 1000) this.audit.length = 1000
  }

  confirmed(
    tokenId: string,
    environment: Environment,
  ): ConfirmationRec | undefined {
    const t = this.now()
    return this.confirmations.find(
      (c) =>
        c.state === 'active' &&
        c.tokenId === tokenId &&
        c.environment === environment &&
        c.expires > t,
    )
  }

  requestConfirmation(input: {
    environment: Environment
    handle: string
    tokenId: string
    device: string
    tool: string | null
    reason: string | null
  }) {
    const t = this.now()
    const pending = this.confirmations.find(
      (c) =>
        c.state === 'pending' &&
        c.tokenId === input.tokenId &&
        c.environment === input.environment &&
        c.expires > t,
    )
    if (pending) return { rec: pending, created: false }
    const rec: ConfirmationRec = {
      id: newId('confirmation', t),
      ...input,
      state: 'pending',
      expires: t + PENDING_MS,
      created: t,
    }
    this.confirmations.unshift(rec)
    if (this.confirmations.length > 200) this.confirmations.length = 200
    this.note(
      input.handle,
      `asked for ${input.environment} values from ${input.device}`,
      { target: input.environment, kind: 'grant' },
    )
    return { rec, created: true }
  }

  clearValues() {
    const had =
      Object.keys(this.sealed).length > 0 ||
      this.confirmations.length > 0 ||
      this.audit.length > 0 ||
      this.mirrors.length > 0
    this.mirrors.length = 0
    for (const k of Object.keys(this.sealed)) delete this.sealed[k]
    for (const v of this.env) v.set = []
    this.confirmations.length = 0
    this.audit.length = 0
    return had
  }

  sealedFor(environment: Environment, names?: ReadonlyArray<string>) {
    const out: Array<{ name: string; secret: boolean; sealed: string }> = []
    for (const v of this.env) {
      if (!v.set.includes(environment)) continue
      if (names && !names.includes(v.name)) continue
      const sealed = this.sealed[v.name]?.[environment]
      if (sealed) out.push({ name: v.name, secret: v.secret, sealed })
    }
    return out
  }
}

export interface ExtrasPort {
  open: (repo: string) => Promise<RepoExtras>
  allMirrors: () => Promise<Array<{ repo: string; mirror: MirrorRec }>>
  rename: (from: string, to: string) => void
  drop: (repo: string) => void
  flush?: () => Promise<void>
}

export class ExtrasStore implements ExtrasPort {
  private readonly repos = new Map<string, RepoExtras>()
  constructor(private readonly now: () => number) {}
  rename(from: string, to: string) {
    const x = this.repos.get(from)
    if (!x) return
    this.repos.delete(from)
    this.repos.set(to, x)
  }

  drop(repo: string) {
    this.repos.delete(repo)
  }

  entries() {
    return this.repos.entries()
  }

  open(repo: string) {
    return Promise.resolve(this.for(repo))
  }

  allMirrors() {
    return Promise.resolve(
      [...this.repos].flatMap(([repo, x]) =>
        x.mirrors.map((mirror) => ({ repo, mirror })),
      ),
    )
  }

  for(repo: string): RepoExtras {
    let x = this.repos.get(repo)
    if (!x) this.repos.set(repo, (x = new RepoExtras(this.now)))
    return x
  }
}
