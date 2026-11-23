import { apiError } from './problem'
import { globMatcher } from './glob'

/**
 * Path limits on a token: a token made for `docs/**` changes nothing outside
 * `docs/`. The globs are the policy's (`glob.ts`), so `src/**` and `*.sql`
 * mean the same here as in a rule. Plain JavaScript: the memory domain and
 * the Convex functions refuse the same writes.
 */

export const MAX_TOKEN_PATHS = 50

/** The touched paths no glob covers, in order. A deleted file is touched. */
export function outsidePaths(
  files: Iterable<string>,
  globs: ReadonlyArray<string>,
): Array<string> {
  const ms = globs.map(globMatcher)
  const out: Array<string> = []
  for (const f of files) if (!ms.some((m) => m.test(f))) out.push(f)
  return out
}

/** The refusal for a write that touches paths outside the token's, or null. */
export function pathRefusal(
  files: Iterable<string>,
  globs: ReadonlyArray<string> | null | undefined,
) {
  if (!globs) return null
  const outside = outsidePaths(files, globs)
  if (!outside.length) return null
  const shown = outside.slice(0, 3).join(', ')
  const more = outside.length > 3 ? ` and ${outside.length - 3} more` : ''
  return {
    code: 'forbidden' as const,
    detail: `This token may only change ${globs.join(', ')}; this touches ${shown}${more}.`,
    hint: `Leave out ${shown}${more}, or use a token whose paths cover them.`,
  }
}

/** Throws the refusal for a write outside the token's paths. */
export function assertWithinPaths(
  files: Iterable<string>,
  globs: ReadonlyArray<string> | null | undefined,
) {
  const r = pathRefusal(files, globs)
  if (r) throw apiError(r.code, r.detail, { hint: r.hint })
}

/** Every path a patch set touches: its files, and any file it holds whole (null is a deletion). */
export function touchedFiles(ps: {
  files: Record<string, unknown>
  contents?: Record<string, unknown> | null
}) {
  return new Set([...Object.keys(ps.files), ...Object.keys(ps.contents ?? {})])
}
