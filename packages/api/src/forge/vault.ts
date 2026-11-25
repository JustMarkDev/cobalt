// Provider tokens at rest. Each value is sealed with AES-GCM under one of
// several keys, and the sealed text names the key, so a new key can be added
// and the old one dropped after every value is sealed again (`reseal`).
//
//   CB_TOKEN_KEYS="k2:<base64url 32 bytes>,k1:<base64url 32 bytes>"
//
// The first key seals; every listed key opens. The additional data binds a
// value to its slot (a connection and a field), so a sealed token copied into
// another row does not open.

const enc = new TextEncoder()
const dec = new TextDecoder()

const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
  dec: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')),
}

export type VaultSlot = { kind: string; id: string; field: string }

const aad = (s: VaultSlot) => enc.encode(`${s.kind}\n${s.id}\n${s.field}`)

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export class TokenVault {
  private constructor(
    private readonly keys: Map<string, CryptoKey>,
    readonly current: string,
  ) {}

  static async fromEnv(
    text: string | undefined | null,
  ): Promise<TokenVault | null> {
    if (!text?.trim()) return null
    const keys = new Map<string, CryptoKey>()
    let current: string | undefined
    for (const part of text.split(',')) {
      const [id, raw] = part.trim().split(':')
      if (!id || !raw || !/^[A-Za-z0-9_-]{1,16}$/.test(id))
        throw new VaultError('CB_TOKEN_KEYS must be "id:base64url,..."')
      const bytes = b64.dec(raw)
      if (bytes.length !== 32)
        throw new VaultError(`Key ${id} in CB_TOKEN_KEYS is not 32 bytes.`)
      keys.set(
        id,
        await crypto.subtle.importKey(
          'raw',
          bytes as BufferSource,
          'AES-GCM',
          false,
          ['encrypt', 'decrypt'],
        ),
      )
      current ??= id
    }
    return new TokenVault(keys, current!)
  }

  /** A vault with a fresh random key, for tests and the sample. */
  static async ephemeral(id = 'test') {
    const raw = b64.enc(crypto.getRandomValues(new Uint8Array(32)))
    return (await TokenVault.fromEnv(`${id}:${raw}`))!
  }

  async seal(slot: VaultSlot, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(slot) },
        this.keys.get(this.current)!,
        enc.encode(value),
      ),
    )
    return `tv1.${this.current}.${b64.enc(iv)}.${b64.enc(ct)}`
  }

  /** The key a sealed value uses, without opening it. */
  static keyOf(sealed: string) {
    return sealed.split('.')[1] ?? null
  }

  async open(slot: VaultSlot, sealed: string): Promise<string> {
    const [v, kid, iv, ct] = sealed.split('.')
    if (v !== 'tv1' || !kid || !iv || !ct)
      throw new VaultError('Not a sealed token.')
    const key = this.keys.get(kid)
    if (!key) throw new VaultError(`The key ${kid} is no longer configured.`)
    try {
      return dec.decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64.dec(iv), additionalData: aad(slot) },
          key,
          b64.dec(ct),
        ),
      )
    } catch {
      throw new VaultError('The sealed token does not open in this slot.')
    }
  }

  /** Seals again under the current key; unchanged when it already uses it. */
  async reseal(slot: VaultSlot, sealed: string): Promise<string> {
    if (TokenVault.keyOf(sealed) === this.current) return sealed
    return this.seal(slot, await this.open(slot, sealed))
  }
}

/**
 * The secret of one repository's webhook: an HMAC of a master secret with the
 * repository's id, so nothing per repository needs storing.
 */
export async function webhookSecret(master: string, remoteRepoId: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(master),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`cobalt:webhook:${remoteRepoId}`),
    ),
  )
  return b64.enc(mac)
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameText(a: string, b: string) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

/** Hex HMAC-SHA256 of a body. */
export async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return Buffer.from(
    await crypto.subtle.sign('HMAC', key, enc.encode(body)),
  ).toString('hex')
}
