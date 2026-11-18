import { newId } from './ids'

/**
 * Per-repository things beyond code and review: mirrors on other hosts, the
 * environment schema with its sealed values, and the confirmations that
 * let a login use production values.
 *
 * Values are the point of care here. Names and kinds are ordinary data.
 * Values are kept sealed (`secret-box.ts`) and opened only in `env.values`,
 * for the repository's team, with production confirmed from a signed-in page
 * first; every read is audited and none is cached.
 */
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
  /** Paused: nothing is sent or fetched until it is resumed. */
  paused?: boolean
}

export type EnvVarRec = {
  name: string
  kind: string
  secret: boolean
  set: Array<Environment>
  description: string
  /** Environments that must have a value. */
  required?: Array<Environment>
  rotated?: { at: number; by: string }
}

/**
 * A request to use production values from one login, and the person's
 * answer. Production values never leave on a token alone: the person who
 * owns the token confirms from a signed-in page, for a while, for that one
 * token. Other environments need no confirmation for the team.
 */
export type ConfirmationRec = {
  id: string
  environment: Environment
  state: GrantState
  /** Whose token asked; only they can confirm it. */
  handle: string
  /** The login it covers: an OAuth authorization (it outlives the hourly tokens it mints) or a personal token. Another login asks again. */
  tokenId: string
  /** The machine the token was made on, so the person knows what they confirm. */
  device: string
  /** What sent the request, as it declared itself. */
  tool: string | null
  reason: string | null
  /** Until when it holds, once confirmed; a pending request lapses after ten minutes. */
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

/** How long an unanswered production request waits. */
export const PENDING_MS = 10 * 60_000

export class RepoExtras {
  readonly mirrors: Array<MirrorRec> = []
  readonly env: Array<EnvVarRec> = []
  /** Sealed values (`secret-box.ts`), by variable, then environment. */
  readonly sealed: Record<string, Partial<Record<Environment, string>>> = {}
  readonly confirmations: Array<ConfirmationRec> = []
  readonly audit: Array<AuditRec> = []

  constructor(private readonly now: () => number) {}

  /** The plain data, for keeping elsewhere. Values stay sealed. */
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

  /** A confirmation in force for this token and environment. */
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

  /**
   * A pending request for this token, made now if there is none. A request
   * that lapsed is left as it was; a fresh one takes its place.
   */
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
    // Old answers are only history; keep the list short.
    if (this.confirmations.length > 200) this.confirmations.length = 200
    this.note(
      input.handle,
      `asked for ${input.environment} values from ${input.device}`,
      { target: input.environment, kind: 'grant' },
    )
    return { rec, created: true }
  }

  /**
   * Forgets every value and confirmation, the old team's audit log and its
   * mirrors, as when the repository changes hands. Names stay. Whether there
   * was anything to forget.
   */
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

  /** The sealed values set for an environment, by name. */
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

/**
 * Where extras are kept. `open` gives a copy to read and change; a store
 * that keeps them elsewhere (`stores/convex-extras.ts`) saves what changed
 * when the request ends. The memory store hands out the object itself.
 */
export interface ExtrasPort {
  open: (repo: string) => Promise<RepoExtras>
  /** Every repository's mirrors, for the status page. */
  allMirrors: () => Promise<Array<{ repo: string; mirror: MirrorRec }>>
  rename: (from: string, to: string) => void
  drop: (repo: string) => void
  /** Saves what this request changed. Called once a request's domain work is done. */
  flush?: () => Promise<void>
}

export class ExtrasStore implements ExtrasPort {
  private readonly repos = new Map<string, RepoExtras>()
  constructor(private readonly now: () => number) {}
  /** A renamed repository keeps its mirrors, variables and grants. */
  rename(from: string, to: string) {
    const x = this.repos.get(from)
    if (!x) return
    this.repos.delete(from)
    this.repos.set(to, x)
  }

  drop(repo: string) {
    this.repos.delete(repo)
  }

  /** Every repository's extras, by address. */
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
