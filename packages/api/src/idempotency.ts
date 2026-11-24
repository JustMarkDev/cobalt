import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export const heldKey = new AsyncLocalStorage<HeldKey>()

export type HeldKey = { scope: string; key: string; lease: string }

export type StoredResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type Begin =
  | { state: 'new'; lease: string }
  | { state: 'replay'; response: StoredResponse }
  | { state: 'conflict' }
  | { state: 'in_progress' }

export interface IdempotencyStore {
  begin: (scope: string, key: string, fingerprint: string) => Promise<Begin>
  complete: (
    scope: string,
    key: string,
    lease: string,
    response: StoredResponse,
  ) => Promise<void>
  abort: (scope: string, key: string, lease: string) => Promise<void>
}

type Entry = {
  fingerprint: string
  lease: string
  response?: StoredResponse
  expires: number
  chars: number
}

function sizeOf(
  id: string,
  fingerprint: string,
  response?: StoredResponse,
): number {
  let n = 160 + id.length + fingerprint.length
  if (response) {
    n += response.body.length
    for (const k in response.headers)
      n += k.length + response.headers[k].length + 24
  }
  return n
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly ttlMs = 24 * 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly max = 100_000,
    private readonly maxChars = 24_000_000,
  ) {}

  private held = 0

  private evict(protect?: string) {
    while (
      (this.entries.size > this.max || this.held > this.maxChars) &&
      this.entries.size > 1
    ) {
      let victim: string | undefined
      for (const [id, entry] of this.entries)
        if (id !== protect && entry.response) {
          victim = id
          break
        }
      if (victim === undefined) break
      this.held -= this.entries.get(victim)!.chars
      this.entries.delete(victim)
    }
  }

  begin(scope: string, key: string, fingerprint: string): Promise<Begin> {
    const id = `${scope}\u0000${key}`
    const now = this.now()
    const found = this.entries.get(id)
    if (found && found.expires > now) {
      if (found.fingerprint !== fingerprint)
        return Promise.resolve({ state: 'conflict' })
      return Promise.resolve(
        found.response
          ? { state: 'replay', response: found.response }
          : { state: 'in_progress' },
      )
    }
    if (found) this.held -= found.chars
    const chars = sizeOf(id, fingerprint)
    this.held += chars
    const lease = `${now.toString(36)}.${++this.leases}`
    this.entries.set(id, {
      fingerprint,
      lease,
      expires: now + this.ttlMs,
      chars,
    })
    this.evict()
    return Promise.resolve({ state: 'new', lease })
  }

  private leases = 0

  complete(
    scope: string,
    key: string,
    lease: string,
    response: StoredResponse,
  ) {
    const id = `${scope}\u0000${key}`
    const entry = this.entries.get(id)
    if (entry && entry.lease === lease && !entry.response) {
      const chars = entry.chars + sizeOf('', '', response) - 160
      this.held += chars - entry.chars
      entry.chars = chars
      entry.response = response
      this.evict(id)
    }
    return Promise.resolve()
  }

  abort(scope: string, key: string, lease: string) {
    const id = `${scope}\u0000${key}`
    const entry = this.entries.get(id)
    if (!entry || entry.lease !== lease || entry.response)
      return Promise.resolve()
    this.held -= entry.chars
    this.entries.delete(id)
    return Promise.resolve()
  }

  get size() {
    return this.entries.size
  }

  sweep() {
    const now = this.now()
    for (const [id, e] of this.entries)
      if (e.expires <= now) {
        this.held -= e.chars
        this.entries.delete(id)
      }
  }
}

export function requestFingerprint(
  method: string,
  path: string,
  query: string,
  body: string,
  ifMatch: string = '',
  contentType: string = '',
  replayStamp: string = '',
): string {
  return createHash('sha256')
    .update(
      `${method}\n${path}\n${query}\n${body}\n${ifMatch}\n${contentType}\n${replayStamp}`,
    )
    .digest('base64url')
}
