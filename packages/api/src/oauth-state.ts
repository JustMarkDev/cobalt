/**
 * What the OAuth server remembers between requests: registered clients,
 * sign-ins waiting for consent, codes, refresh tokens and device codes.
 * `MemoryOAuthState` keeps them in this process; the Convex one
 * (`stores/convex-oauth.ts`) keeps them in the database, so any API server
 * can finish a flow another one started.
 */
export type OAuthKind =
  | 'client'
  | 'pending'
  | 'code'
  | 'refresh'
  | 'device'
  /** How fast a device code is polled, apart from the code, so polling never rewrites it. */
  | 'device_poll'
  | 'user_code'

export interface OAuthState {
  get: <T>(kind: OAuthKind, key: string) => Promise<T | undefined>
  /** `expires` null keeps it until deleted. */
  set: (
    kind: OAuthKind,
    key: string,
    value: unknown,
    expires: number | null,
  ) => Promise<void>
  delete: (kind: OAuthKind, key: string) => Promise<void>
  /**
   * Marks it used and answers it as it was, in one step: of two requests
   * using the same code at once, exactly one sees it unused.
   */
  use: <T>(kind: OAuthKind, key: string) => Promise<T | undefined>
  /**
   * Replaces it only while its `field` is still `from`, in one step: of two
   * writes racing to move it on, exactly one does. Answers whether it did.
   */
  swap: (
    kind: OAuthKind,
    key: string,
    field: string,
    from: string,
    value: unknown,
    expires: number | null,
  ) => Promise<boolean>
  /** How many there are, counting no further than `upTo`. */
  count: (kind: OAuthKind, upTo: number) => Promise<number>
  /** Forget what expired. */
  sweep: (now: number) => Promise<void>
}

type Entry = { value: unknown; expires: number | null }

export class MemoryOAuthState implements OAuthState {
  private readonly maps = new Map<OAuthKind, Map<string, Entry>>()

  private map(kind: OAuthKind) {
    let m = this.maps.get(kind)
    if (!m) this.maps.set(kind, (m = new Map()))
    return m
  }

  get<T>(kind: OAuthKind, key: string) {
    // A copy, as a database would give: a change counts only once it is set.
    const e = this.map(kind).get(key)
    return Promise.resolve(e ? (structuredClone(e.value) as T) : undefined)
  }

  set(kind: OAuthKind, key: string, value: unknown, expires: number | null) {
    this.map(kind).set(key, { value: structuredClone(value), expires })
    return Promise.resolve()
  }

  delete(kind: OAuthKind, key: string) {
    this.map(kind).delete(key)
    return Promise.resolve()
  }

  use<T>(kind: OAuthKind, key: string) {
    const e = this.map(kind).get(key)
    if (!e) return Promise.resolve(undefined)
    const before = structuredClone(e.value) as T
    ;(e.value as { used?: boolean }).used = true
    return Promise.resolve(before)
  }

  swap(
    kind: OAuthKind,
    key: string,
    field: string,
    from: string,
    value: unknown,
    expires: number | null,
  ) {
    const e = this.map(kind).get(key)
    if (!e || (e.value as Record<string, unknown>)[field] !== from)
      return Promise.resolve(false)
    this.map(kind).set(key, { value: structuredClone(value), expires })
    return Promise.resolve(true)
  }

  count(kind: OAuthKind, upTo: number) {
    return Promise.resolve(Math.min(this.map(kind).size, upTo))
  }

  sweep(now: number) {
    let total = 0
    for (const m of this.maps.values()) total += m.size
    if (total >= 200)
      for (const m of this.maps.values())
        for (const [k, e] of m)
          if (e.expires !== null && e.expires < now) m.delete(k)
    return Promise.resolve()
  }
}
