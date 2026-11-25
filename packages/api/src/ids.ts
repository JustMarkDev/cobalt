export const idPrefixes = {
  account: 'acc',
  repo: 'rep',
  change: 'chg',
  issue: 'iss',
  finding: 'fnd',
  review: 'rev',
  check: 'chk',
  stack: 'stk',
  token: 'tok',
  operation: 'op',
  event: 'evt',
  request: 'req',
  comment: 'cmt',
  authorization: 'atz',
  webhook: 'whk',
  delivery: 'dlv',
  upload: 'upl',
  evidence: 'evd',
  mirror: 'mir',
  grant: 'grt',
  confirmation: 'cnf',
  team: 'tem',
  run: 'run',
  invitation: 'inv',
  label: 'lbl',
  notification: 'ntf',
  release: 'rel',
  pipeline: 'pip',
  exception: 'pex',
  automation: 'aut',
  runner: 'rnr',
  accessRule: 'acr',
} as const

export type IdKind = keyof typeof idPrefixes

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

let lastMs = -1
let lastText = ''
function encodeTime(ms: number): string {
  if (ms === lastMs) return lastText
  let out = ''
  let n = ms
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out
    n = Math.floor(n / 32)
  }
  lastMs = ms
  lastText = out
  return out
}

export const randomSource = {
  bytes: (n: number): Uint8Array => randomBytes(n),
}

export const randomBuffer = (n: number) => Buffer.from(randomSource.bytes(n))

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

const POOL = 4096
let pool: Uint8Array = new Uint8Array(0)
let at = 0
function take(length: number): Uint8Array {
  if (randomSource.bytes !== defaultBytes) return randomSource.bytes(length)
  if (at + length > pool.length) {
    pool = randomBytes(POOL)
    at = 0
  }
  const out = pool.subarray(at, at + length)
  at += length
  return out
}
const defaultBytes = randomSource.bytes

function randomChars(length: number): string {
  const bytes = take(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 32]
  return out
}

export function newId(kind: IdKind, when: number = Date.now()): string {
  return `${idPrefixes[kind]}_${encodeTime(when)}${randomChars(8)}`
}

export function seededId(kind: IdKind, when: number, tag: string): string {
  let h = 2166136261
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[(h >>> (i * 4)) % 32]
    h = Math.imul(h ^ (h >>> 13), 1274126177)
  }
  return `${idPrefixes[kind]}_${encodeTime(when)}${out}`
}
