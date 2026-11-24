import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

export type SeenMark = { patchSet: number; hash: string }

type PatchSetLike = {
  n: number
  files: Record<string, { hash: string }>
  contents?: Record<string, string | null>
}

export function fileKey(ps: PatchSetLike, path: string): string {
  const text = ps.contents?.[path]
  return text !== undefined
    ? `c:${bytesToHex(sha256(utf8ToBytes(text ?? '\u0000deleted')))}`
    : `h:${ps.files[path].hash}`
}

export function presentSeen(
  change: number,
  head: PatchSetLike,
  marks: ReadonlyMap<string, SeenMark>,
) {
  const files = Object.keys(head.files)
    .sort()
    .map((path) => {
      const m = marks.get(path)
      const seen = !!m && m.hash === fileKey(head, path)
      return {
        path,
        seen,
        patch_set: m?.patchSet ?? null,
        changed_since: !!m && !seen,
      }
    })
  return {
    object: 'change_seen' as const,
    change,
    patch_set: head.n,
    seen: files.filter((f) => f.seen).length,
    total: files.length,
    files,
  }
}
