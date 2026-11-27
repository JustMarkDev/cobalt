const VERSION = 'v1'
const SALT = new TextEncoder().encode('cobalt secrets v1')

const b64url = {
  encode(bytes: Uint8Array) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  decode(text: string) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  },
}

export type Slot = { repoId: string; environment: string; name: string }

const aad = (s: Slot) =>
  new TextEncoder().encode(`${s.repoId}\n${s.environment}\n${s.name}`)

export class SecretBox {
  private readonly keys = new Map<string, Promise<CryptoKey>>()

  private constructor(private readonly master: CryptoKey) {}

  /**
   * The key from CB_SECRETS_KEY: 32 bytes, as base64 or hex (what `openssl
   * rand -hex 32` prints). Anything else leaves the server without secret
   * values, and says so in the log.
   */
  static async fromBase64(text: string | undefined | null) {
    if (!text) return null
    const t = text.trim()
    let raw: Uint8Array | null = null
    if (/^[0-9a-f]{64}$/i.test(t))
      raw = Uint8Array.from(t.match(/../g)!.map((h) => parseInt(h, 16)))
    else
      try {
        raw = b64url.decode(t)
      } catch {
        raw = null
      }
    if (raw?.length !== 32) {
      console.error(
        `[secrets] CB_SECRETS_KEY is not 32 bytes as base64 or hex (${raw ? `${raw.length} bytes` : 'not base64'}): secret values are off.`,
      )
      return null
    }
    return SecretBox.fromBytes(raw)
  }

  static ephemeral() {
    return SecretBox.fromBytes(crypto.getRandomValues(new Uint8Array(32)))
  }

  private static async fromBytes(raw: Uint8Array) {
    const master = await crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      'HKDF',
      false,
      ['deriveKey'],
    )
    return new SecretBox(master)
  }

  private keyFor(repoId: string) {
    let k = this.keys.get(repoId)
    if (!k) {
      k = crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: SALT,
          info: new TextEncoder().encode(`repo:${repoId}`),
        },
        this.master,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
      this.keys.set(repoId, k)
    }
    return k
  }

  async seal(slot: Slot, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(slot) },
        await this.keyFor(slot.repoId),
        new TextEncoder().encode(value),
      ),
    )
    return `${VERSION}.${b64url.encode(iv)}.${b64url.encode(ct)}`
  }

  async open(slot: Slot, sealed: string): Promise<string | null> {
    const [version, iv, ct] = sealed.split('.')
    if (version !== VERSION || !iv || !ct) return null
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64url.decode(iv), additionalData: aad(slot) },
        await this.keyFor(slot.repoId),
        b64url.decode(ct),
      )
      return new TextDecoder().decode(plain)
    } catch {
      return null
    }
  }
}
