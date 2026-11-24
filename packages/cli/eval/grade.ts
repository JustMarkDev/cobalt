export type Call = {
  tool: string
  args: Record<string, unknown>
  isError: boolean
}

export type Trajectory = {
  calls: Array<Call>
  final: string
  stopReason: string | null
}

type ArgCheck = unknown

export type CallMatch = {
  tool: string
  args?: Record<string, ArgCheck>
  why?: string
}

export type Case = {
  id: string
  prompt: string
  expect?: Array<CallMatch>
  forbid?: Array<CallMatch>
  first?: string
  order?: Array<string>
  maxCalls?: number
  says?: Array<RegExp>
  neverSays?: Array<RegExp>
}

function argMatches(check: ArgCheck, value: unknown): boolean {
  if (check instanceof RegExp) return check.test(stringify(value))
  if (typeof check === 'function')
    return (check as (v: unknown) => boolean)(value)
  if (check && typeof check === 'object')
    return JSON.stringify(check) === JSON.stringify(value)
  return check === value
}

const stringify = (v: unknown) =>
  typeof v === 'string' ? v : JSON.stringify(v ?? '')

export function callMatches(m: CallMatch, c: Call): boolean {
  if (m.tool !== c.tool) return false
  return Object.entries(m.args ?? {}).every(([k, check]) =>
    argMatches(check, c.args[k]),
  )
}

const describe = (m: CallMatch) =>
  `${m.tool}${m.args ? `(${Object.keys(m.args).join(', ')})` : ''}${m.why ? `: ${m.why}` : ''}`

export function grade(k: Case, t: Trajectory): Array<string> {
  const failures: Array<string> = []
  if (t.stopReason === 'refusal') failures.push('the model refused')
  for (const m of k.expect ?? [])
    if (!t.calls.some((c) => callMatches(m, c)))
      failures.push(`never called ${describe(m)}`)
  for (const m of k.forbid ?? [])
    if (t.calls.some((c) => callMatches(m, c)))
      failures.push(`called ${describe(m)}`)
  if (k.first && t.calls[0]?.tool !== k.first)
    failures.push(
      `the first call was ${t.calls[0]?.tool ?? 'none'}, not ${k.first}`,
    )
  if (k.order) {
    const firsts = k.order
      .map((tool) => t.calls.findIndex((c) => c.tool === tool))
      .filter((i) => i >= 0)
    if (firsts.some((i, n) => n > 0 && i < firsts[n - 1]))
      failures.push(`called out of order; expected ${k.order.join(' → ')}`)
  }
  if (k.maxCalls !== undefined && t.calls.length > k.maxCalls)
    failures.push(`${t.calls.length} tool calls, more than ${k.maxCalls}`)
  for (const re of k.says ?? [])
    if (!re.test(t.final)) failures.push(`the answer does not say ${re}`)
  for (const re of k.neverSays ?? [])
    if (re.test(t.final)) failures.push(`the answer says ${re}`)
  return failures
}
