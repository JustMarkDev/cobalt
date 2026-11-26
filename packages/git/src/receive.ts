// What a `git push` asked for and what the server took, read from the
// smart-HTTP receive-pack exchange as it passes through, so a push through
// cobalt counts at once instead of when Code Storage's webhook arrives.

export type RefUpdate = { ref: string; before: string; after: string }

const dec = new TextDecoder()

/** Read whole pkt-lines from the front of `buf`, stopping at the first flush. */
function lines(buf: Uint8Array): { lines: Array<string>; done: boolean } {
  const out: Array<string> = []
  let at = 0
  while (at + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(at, at + 4)), 16)
    if (Number.isNaN(len)) return { lines: out, done: true }
    if (len === 0) return { lines: out, done: true }
    if (len < 4 || at + len > buf.length) return { lines: out, done: false }
    out.push(dec.decode(buf.subarray(at + 4, at + len)))
    at += len
  }
  return { lines: out, done: false }
}

/** The ref updates at the head of a receive-pack request (before the pack). */
export function commandsOf(head: Uint8Array): Array<RefUpdate> | null {
  const { lines: ls, done } = lines(head)
  if (!done) return null
  const out: Array<RefUpdate> = []
  for (const l of ls) {
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([^\0\n]+)/.exec(l)
    if (m) out.push({ before: m[1], after: m[2], ref: m[3] })
  }
  return out
}

/**
 * The refs a receive-pack answer says it updated (`ok <ref>`), with or
 * without side-band. Null when the pack did not unpack.
 */
export function acceptedOf(answer: Uint8Array): Set<string> | null {
  // Side-band: each pkt-line starts with a band byte; band 1 holds the
  // report, itself made of pkt-lines.
  const parts: Array<Uint8Array> = []
  let at = 0
  let banded = false
  while (at + 4 <= answer.length) {
    const len = parseInt(dec.decode(answer.subarray(at, at + 4)), 16)
    if (Number.isNaN(len) || len === 0) {
      at += 4
      continue
    }
    const body = answer.subarray(at + 4, at + len)
    if (body[0] === 1 || body[0] === 2 || body[0] === 3) {
      banded = true
      if (body[0] === 1) parts.push(body.subarray(1))
    } else if (!banded) parts.push(answer.subarray(at, at + len))
    at += len
  }
  const report = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    report.set(p, o)
    o += p.length
  }
  const text = (banded ? allLines(report) : allLines(answer)).map((l) =>
    l.trim(),
  )
  if (!text.includes('unpack ok')) return null
  return new Set(
    text.filter((l) => l.startsWith('ok ')).map((l) => l.slice(3).trim()),
  )
}

function allLines(buf: Uint8Array): Array<string> {
  const out: Array<string> = []
  let at = 0
  while (at + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(at, at + 4)), 16)
    if (Number.isNaN(len)) break
    if (len === 0) {
      at += 4
      continue
    }
    out.push(dec.decode(buf.subarray(at + 4, at + len)))
    at += len
  }
  return out
}

/** Read a stream until `enough` says the bytes so far suffice, then stop. */
export async function readHead(
  stream: ReadableStream<Uint8Array>,
  enough: (buf: Uint8Array) => boolean,
  max = 1 << 20,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  let buf = new Uint8Array(0)
  try {
    while (buf.length < max) {
      const { value, done } = await reader.read()
      if (done) break
      const next = new Uint8Array(buf.length + value.length)
      next.set(buf)
      next.set(value, buf.length)
      buf = next
      if (enough(buf)) break
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return buf
}

/** Read a whole stream. */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
