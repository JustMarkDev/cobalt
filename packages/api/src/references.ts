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

export function mentions(text: string): Array<string> {
  const out: Array<string> = []
  for (const m of text.matchAll(/(?:^|[^\w@/])@([a-z0-9][a-z0-9-]{0,38})/gi))
    if (!out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase())
  return out.slice(0, 10)
}
