export type Suggestion = {
  summary: string
  file: string
  replace: Array<string>
  after?: string
  lines: Array<string>
}

export type Applied =
  | { ok: true; contents: string; at: number }
  | { ok: false; reason: 'moved' | 'ambiguous' }

const split = (contents: string) => {
  const trailing = contents.endsWith('\n')
  const lines = (trailing ? contents.slice(0, -1) : contents).split('\n')
  return { lines, trailing }
}

function find(lines: Array<string>, block: Array<string>) {
  const hits: Array<number> = []
  for (let i = 0; i + block.length <= lines.length; i++)
    if (block.every((l, j) => lines[i + j] === l)) hits.push(i)
  if (hits.length === 0) return { ok: false, reason: 'moved' } as const
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' } as const
  return { ok: true, index: hits[0] } as const
}

export function applySuggestion(contents: string, s: Suggestion): Applied {
  const { lines, trailing } = split(contents)
  const insert = s.replace.length === 0
  const target = insert ? [s.after ?? ''] : s.replace
  const hit = find(lines, target)
  if (!hit.ok) return hit
  const from = insert ? hit.index + 1 : hit.index
  const next = [
    ...lines.slice(0, from),
    ...s.lines,
    ...lines.slice(from + s.replace.length),
  ]
  return {
    ok: true,
    contents: next.join('\n') + (trailing ? '\n' : ''),
    at: from + 1,
  }
}

export const canApply = (contents: string, s: Suggestion) =>
  applySuggestion(contents, s).ok

export function lineOf(contents: string, text: string, fallback: number) {
  const { lines } = split(contents)
  const hits = lines.flatMap((l, i) => (l === text ? [i + 1] : []))
  return hits.length === 1 ? hits[0] : fallback
}
