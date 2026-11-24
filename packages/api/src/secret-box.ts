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

  static async fromBase64(text: string | undefined | null) {
    if (!text) return null
    let raw: Uint8Array
    try {
      raw = b64url.decode(text.trim())
    } catch {
      return null
    }
    if (raw.length !== 32) return null
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
