// Copy every branch and tag from one smart-HTTP git server to another, with
// fetch alone: one upload-pack from the source, one receive-pack into the
// target. Used to give an empty repository on another host the history of a
// repository here before the two are linked.

export type Endpoint = { url: string; authorization: string }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const enc = new TextEncoder()
const dec = new TextDecoder()
const ZERO = '0'.repeat(40)

export function pkt(line: string): Uint8Array {
  const body = enc.encode(line)
  const head = (body.length + 4).toString(16).padStart(4, '0')
  return concat([enc.encode(head), body])
}

const FLUSH = enc.encode('0000')

export function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** pkt-lines up to `end` (or the whole buffer), and where they stopped. */
export function readPkts(
  buf: Uint8Array,
  from = 0,
  stopAtFlush = false,
): { lines: Array<string | null>; next: number } {
  const lines: Array<string | null> = []
  let at = from
  while (at + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(at, at + 4)), 16)
    if (Number.isNaN(len)) break
    if (len === 0) {
      lines.push(null)
      at += 4
      if (stopAtFlush) break
      continue
    }
    lines.push(dec.decode(buf.subarray(at + 4, at + len)))
    at += len
  }
  return { lines, next: at }
}

/** Branches and tags a server advertises (protocol v0), without peeled `^{}`. */
export function advertised(buf: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>()
  for (const line of readPkts(buf).lines) {
    if (!line || line.startsWith('#')) continue
    const [sha, rest = ''] = line.replace(/\n$/, '').split(' ')
    const name = rest.split('\0')[0]
    if (
      /^[0-9a-f]{40}$/.test(sha) &&
      sha !== ZERO &&
      /^refs\/(heads|tags)\//.test(name) &&
      !name.endsWith('^{}')
    )
      refs.set(name, sha)
  }
  return refs
}

async function infoRefs(f: Fetch, e: Endpoint, service: string) {
  const res = await f(`${e.url}/info/refs?service=${service}`, {
    headers: { authorization: e.authorization, 'user-agent': 'git/cobalt' },
  })
  if (!res.ok)
    throw new Error(`${service} refs answered ${res.status} at ${e.url}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Push every branch and tag of `from` into `to`, which must not have them
 * yet. Returns the refs it copied.
 */
export async function copyHistory(
  from: Endpoint,
  to: Endpoint,
  o: {
    /** Sent first: an empty GitHub repository takes it as its default branch. */
    first?: string
    fetch?: Fetch
  } = {},
): Promise<Map<string, string>> {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i))
  const all = advertised(await infoRefs(f, from, 'git-upload-pack'))
  const head = o.first !== undefined ? all.get(o.first) : undefined
  const refs = new Map(
    head !== undefined && o.first !== undefined
      ? [[o.first, head] as const, ...[...all].filter(([n]) => n !== o.first)]
      : all,
  )
  if (refs.size === 0) return refs
  const there = advertised(await infoRefs(f, to, 'git-receive-pack'))
  const wants = [...new Set(refs.values())]

  const ask = concat([
    pkt(`want ${wants[0]} ofs-delta no-progress\n`),
    ...wants.slice(1).map((w) => pkt(`want ${w}\n`)),
    FLUSH,
    pkt('done\n'),
  ])
  const up = await f(`${from.url}/git-upload-pack`, {
    method: 'POST',
    headers: {
      authorization: from.authorization,
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
      'user-agent': 'git/cobalt',
    },
    body: ask as BodyInit,
  })
  if (!up.ok) throw new Error(`upload-pack answered ${up.status}`)
  const got = new Uint8Array(await up.arrayBuffer())
  // NAK, then the pack itself.
  const start = indexOf(got, enc.encode('PACK'))
  if (start < 0) throw new Error('upload-pack sent no pack')
  const pack = got.subarray(start)

  const commands = [...refs].map(
    ([name, sha], i) =>
      `${there.get(name) ?? ZERO} ${sha} ${name}${i === 0 ? '\0report-status ofs-delta' : ''}\n`,
  )
  const send = concat([...commands.map(pkt), FLUSH, pack])
  const down = await f(`${to.url}/git-receive-pack`, {
    method: 'POST',
    headers: {
      authorization: to.authorization,
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
      'user-agent': 'git/cobalt',
    },
    body: send as BodyInit,
  })
  if (!down.ok) throw new Error(`receive-pack answered ${down.status}`)
  const report = readPkts(new Uint8Array(await down.arrayBuffer()))
    .lines.filter((l): l is string => l !== null)
    .map((l) => l.trim())
  const unpack = report.find((l) => l.startsWith('unpack '))
  if (unpack && unpack !== 'unpack ok')
    throw new Error(`push failed: ${unpack}`)
  const refused = report.filter((l) => l.startsWith('ng '))
  if (refused.length) throw new Error(`push refused: ${refused.join('; ')}`)
  return refs
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
