import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { newId, randomBuffer } from './ids'

export type Purpose = 'evidence' | 'release'

export const ALLOWED: Record<
  string,
  { max: number; check: (b: Uint8Array) => boolean; inline: boolean }
> = {
  'image/png': {
    max: 10 << 20,
    check: (b) => eq(b, [0x89, 0x50, 0x4e, 0x47]),
    inline: true,
  },
  'image/jpeg': {
    max: 10 << 20,
    check: (b) => eq(b, [0xff, 0xd8, 0xff]),
    inline: true,
  },
  'image/gif': {
    max: 10 << 20,
    check: (b) => eq(b, [0x47, 0x49, 0x46, 0x38]),
    inline: true,
  },
  'image/webp': {
    max: 10 << 20,
    check: (b) =>
      eq(b, [0x52, 0x49, 0x46, 0x46]) &&
      eq(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
    inline: true,
  },
  'video/mp4': {
    max: 50 << 20,
    check: (b) => eq(b.subarray(4), [0x66, 0x74, 0x79, 0x70]),
    inline: true,
  },
  'video/webm': {
    max: 50 << 20,
    check: (b) => eq(b, [0x1a, 0x45, 0xdf, 0xa3]),
    inline: true,
  },
  'application/json': { max: 5 << 20, check: (b) => parses(b), inline: false },
  'text/plain': { max: 5 << 20, check: (b) => utf8(b), inline: false },
  'text/html': { max: 5 << 20, check: (b) => utf8(b), inline: false },
  'application/octet-stream': {
    max: 100 << 20,
    check: () => true,
    inline: false,
  },
  'application/zip': {
    max: 100 << 20,
    check: (b) => eq(b, [0x50, 0x4b, 0x03, 0x04]),
    inline: false,
  },
  'application/gzip': {
    max: 100 << 20,
    check: (b) => eq(b, [0x1f, 0x8b]),
    inline: false,
  },
}

export const RELEASE_ONLY = new Set([
  'application/octet-stream',
  'application/zip',
  'application/gzip',
])

function eq(b: Uint8Array, sig: Array<number>) {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v)
}
function utf8(b: Uint8Array) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}
function parses(b: Uint8Array) {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b))
    return true
  } catch {
    return false
  }
}

export interface BlobStore {
  put: (id: string, bytes: Uint8Array) => void | Promise<void>
  get: (id: string) => Uint8Array | null | Promise<Uint8Array | null>
  delete?: (id: string) => void | Promise<void>
  readonly bytes: number
  readonly capacity?: number
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>()
  private total = 0
  constructor(readonly capacity = 256 << 20) {}
  put(id: string, bytes: Uint8Array) {
    this.total += bytes.byteLength - (this.blobs.get(id)?.byteLength ?? 0)
    this.blobs.set(id, bytes)
  }
  get(id: string) {
    return this.blobs.get(id) ?? null
  }
  delete(id: string) {
    const old = this.blobs.get(id)
    if (old) this.total -= old.byteLength
    this.blobs.delete(id)
  }
  get bytes() {
    return this.total
  }
}

export type UploadRec = {
  id: string
  owner: string
  filename: string
  contentType: string
  size: number
  purpose: Purpose
  state: 'pending' | 'uploaded'
  sha256: string | null
  expires: number
  created: number
  attachedTo: string | null
  attachedRepoId: string | null
}

type MaybePromise<T> = T | Promise<T>

export interface UploadPort {
  readonly blobs: BlobStore
  create: (
    owner: string,
    input: {
      filename: string
      contentType: string
      size: number
      purpose: Purpose
    },
  ) => MaybePromise<UploadRec | null>
  get: (id: string) => MaybePromise<UploadRec | null>
  countPending: (owner: string) => MaybePromise<number>
  sign: (rec: UploadRec) => string
  verify: (rec: UploadRec, exp: number, sig: string) => boolean
  put: (
    rec: UploadRec,
    bytes: Uint8Array,
    contentType: string,
  ) => MaybePromise<string | null>
  dropRepo: (repoId: string) => MaybePromise<void>
  remove: (id: string) => MaybePromise<void>
  sweepNow: () => MaybePromise<void>
  flush?: () => Promise<void>
}

export function checkFile(
  rec: UploadRec,
  bytes: Uint8Array,
  contentType: string,
  blobs: BlobStore,
): string | null {
  if (rec.state === 'uploaded') return 'This upload already has its file.'
  if (contentType.split(';')[0].trim().toLowerCase() !== rec.contentType)
    return `Send Content-Type: ${rec.contentType}.`
  if (bytes.byteLength !== rec.size)
    return `Expected ${rec.size} bytes, got ${bytes.byteLength}.`
  const rule = ALLOWED[rec.contentType]
  if (!rule.check(bytes)) return `The file is not a valid ${rec.contentType}.`
  if (
    blobs.capacity !== undefined &&
    blobs.bytes + bytes.byteLength > blobs.capacity
  )
    return 'full'
  return null
}

export class UploadSigner {
  constructor(private readonly secret: Buffer = randomBuffer(32)) {}

  private mac(id: string, exp: number, type: string, size: number) {
    return createHmac('sha256', this.secret)
      .update(`${id}.${exp}.${type}.${size}`)
      .digest()
  }

  sign(rec: UploadRec): string {
    return `exp=${rec.expires}&sig=${this.mac(rec.id, rec.expires, rec.contentType, rec.size).toString('base64url')}`
  }

  verify(rec: UploadRec, exp: number, sig: string, now: number): boolean {
    if (exp !== rec.expires || exp < now) return false
    const want = this.mac(rec.id, exp, rec.contentType, rec.size)
    const got = Buffer.from(sig, 'base64url')
    return got.length === want.length && timingSafeEqual(got, want)
  }
}

export const sha256Hex = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

const TTL = 3_600_000
const MAX_UPLOADS = 20_000

export class UploadService implements UploadPort {
  private readonly uploads = new Map<string, UploadRec>()
  private waiting: Array<UploadRec> = []
  private waitingFrom = 0
  private completed: Array<UploadRec> = []
  private completedFrom = 0
  private readonly pendingBy = new Map<string, number>()
  private readonly counted = new WeakSet<UploadRec>()
  private readonly secret: Buffer

  constructor(
    readonly blobs: BlobStore,
    private readonly now: () => number = Date.now,
    secret?: Buffer,
  ) {
    this.secret = secret ?? randomBuffer(32)
  }

  private mac(id: string, exp: number, type: string, size: number) {
    return createHmac('sha256', this.secret)
      .update(`${id}.${exp}.${type}.${size}`)
      .digest()
  }

  create(
    owner: string,
    input: {
      filename: string
      contentType: string
      size: number
      purpose: Purpose
    },
  ): UploadRec | null {
    if (this.uploads.size >= MAX_UPLOADS) {
      this.sweep()
      for (const [id, rec] of this.uploads) {
        if (this.uploads.size < MAX_UPLOADS) break
        if (rec.state === 'uploaded' && rec.attachedTo === null) {
          this.uploads.delete(id)
          void this.blobs.delete?.(id)
        }
      }
      if (this.uploads.size >= MAX_UPLOADS) return null
    }
    const t = this.now()
    const rec: UploadRec = {
      id: newId('upload', t),
      owner,
      filename: input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200),
      contentType: input.contentType,
      size: input.size,
      purpose: input.purpose,
      state: 'pending',
      sha256: null,
      expires: t + TTL,
      created: t,
      attachedTo: null,
      attachedRepoId: null,
    }
    this.uploads.set(rec.id, rec)
    this.waiting.push(rec)
    this.counted.add(rec)
    this.pendingBy.set(owner, (this.pendingBy.get(owner) ?? 0) + 1)
    return rec
  }

  private settle(rec: UploadRec) {
    if (!this.counted.delete(rec)) return
    const n = (this.pendingBy.get(rec.owner) ?? 1) - 1
    if (n <= 0) this.pendingBy.delete(rec.owner)
    else this.pendingBy.set(rec.owner, n)
  }

  private sweep() {
    const t = this.now()
    while (
      this.waitingFrom < this.waiting.length &&
      this.waiting[this.waitingFrom].expires <= t
    ) {
      const rec = this.waiting[this.waitingFrom++]
      this.settle(rec)
      if (rec.state === 'pending') this.uploads.delete(rec.id)
    }
    if (this.waitingFrom > 1024 && this.waitingFrom * 2 > this.waiting.length) {
      this.waiting = this.waiting.slice(this.waitingFrom)
      this.waitingFrom = 0
    }
    while (
      this.completedFrom < this.completed.length &&
      this.completed[this.completedFrom].expires + 86_400_000 <= t
    ) {
      const rec = this.completed[this.completedFrom++]
      if (rec.state === 'uploaded' && rec.attachedTo === null) {
        this.uploads.delete(rec.id)
        void this.blobs.delete?.(rec.id)
      }
    }
    if (
      this.completedFrom > 1024 &&
      this.completedFrom * 2 > this.completed.length
    ) {
      this.completed = this.completed.slice(this.completedFrom)
      this.completedFrom = 0
    }
  }

  sweepNow() {
    this.sweep()
  }

  dropRepo(repoId: string) {
    for (const [id, rec] of this.uploads)
      if (rec.attachedRepoId === repoId) {
        this.uploads.delete(id)
        void this.blobs.delete?.(id)
      }
  }

  get(id: string) {
    return this.uploads.get(id) ?? null
  }

  remove(id: string) {
    const rec = this.uploads.get(id)
    if (!rec) return
    this.settle(rec)
    this.uploads.delete(id)
    void this.blobs.delete?.(id)
  }

  countPending(owner: string) {
    this.sweep()
    return this.pendingBy.get(owner) ?? 0
  }

  sign(rec: UploadRec): string {
    return `exp=${rec.expires}&sig=${this.mac(rec.id, rec.expires, rec.contentType, rec.size).toString('base64url')}`
  }

  verify(rec: UploadRec, exp: number, sig: string): boolean {
    if (exp !== rec.expires || exp < this.now()) return false
    const want = this.mac(rec.id, exp, rec.contentType, rec.size)
    const got = Buffer.from(sig, 'base64url')
    return got.length === want.length && timingSafeEqual(got, want)
  }

  put(rec: UploadRec, bytes: Uint8Array, contentType: string): string | null {
    const problem = checkFile(rec, bytes, contentType, this.blobs)
    if (problem) return problem
    void this.blobs.put(rec.id, bytes)
    rec.sha256 = createHash('sha256').update(bytes).digest('hex')
    this.settle(rec)
    rec.state = 'uploaded'
    this.completed.push(rec)
    return null
  }
}
