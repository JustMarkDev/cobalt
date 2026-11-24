const LINK =
  /\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|part of|related to)[:\s]+#(\d+)\b/gi

export function issueRefs(
  text: string,
): Array<{ issue: number; closes: boolean }> {
  const out = new Map<number, boolean>()
  for (const m of text.matchAll(LINK)) {
    const issue = Number(m[2])
    const closes = /^(fix|close|resolve)/i.test(m[1])
    out.set(issue, (out.get(issue) ?? false) || closes)
  }
  return [...out].map(([issue, closes]) => ({ issue, closes }))
}
