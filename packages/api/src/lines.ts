const MAX_CELLS = 4_000_000

export const splitLines = (text: string | null | undefined) =>
  text === null || text === undefined || text === ''
    ? []
    : text.replace(/\n$/, '').split('\n')

export function mapLines(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: a.length }, () => null)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out[start] = start
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
    out[endA] = endB
  }
  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return out
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[start + i] === b[start + j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out[start + i] = start + j
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

export function blameLine(
  versions: ReadonlyArray<string | null>,
  line: number,
  baseIsBefore = false,
): number {
  let at = versions.length - 1
  let idx = line - 1
  while (at > 0) {
    const map = mapLines(splitLines(versions[at - 1]), splitLines(versions[at]))
    const from = map.indexOf(idx)
    if (from < 0) return at
    idx = from
    at--
  }
  return baseIsBefore ? -1 : 0
}

export function findQuote(
  lines: ReadonlyArray<string>,
  quote: ReadonlyArray<string>,
  around: { before: ReadonlyArray<string>; after: ReadonlyArray<string> },
  near: number,
): number | null {
  if (!quote.length || quote.every((l) => l.trim() === '')) return null
  let best: { at: number; score: number; dist: number } | null = null
  for (let i = 0; i + quote.length <= lines.length; i++) {
    let hit = true
    for (let k = 0; k < quote.length && hit; k++)
      hit = lines[i + k].trim() === quote[k].trim()
    if (!hit) continue
    let score = 0
    for (let k = 1; k <= around.before.length; k++)
      if (
        lines[i - k]?.trim() === around.before[around.before.length - k]?.trim()
      )
        score++
    for (let k = 0; k < around.after.length; k++)
      if (lines[i + quote.length + k]?.trim() === around.after[k]?.trim())
        score++
    const dist = Math.abs(i + 1 - near)
    if (
      !best ||
      score > best.score ||
      (score === best.score && dist < best.dist)
    )
      best = { at: i + 1, score, dist }
  }
  return best?.at ?? null
}

/** Lines added and removed between two versions of a file (null = absent). */
export function lineCounts(before: string | null, after: string | null) {
  const a = before === null ? [] : before.split('\n')
  const b = after === null ? [] : after.split('\n')
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
  const same = dp[0][0]
  return { add: b.length - same, del: a.length - same }
}
