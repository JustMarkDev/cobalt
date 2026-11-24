import { apiError } from './problem'
import { globMatcher } from './glob'

export const MAX_TOKEN_PATHS = 50

export function outsidePaths(
  files: Iterable<string>,
  globs: ReadonlyArray<string>,
): Array<string> {
  const ms = globs.map(globMatcher)
  const out: Array<string> = []
  for (const f of files) if (!ms.some((m) => m.test(f))) out.push(f)
  return out
}

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

export function assertWithinPaths(
  files: Iterable<string>,
  globs: ReadonlyArray<string> | null | undefined,
) {
  const r = pathRefusal(files, globs)
  if (r) throw apiError(r.code, r.detail, { hint: r.hint })
}

export function touchedFiles(ps: {
  files: Record<string, unknown>
  contents?: Record<string, unknown> | null
}) {
  return new Set([...Object.keys(ps.files), ...Object.keys(ps.contents ?? {})])
}
