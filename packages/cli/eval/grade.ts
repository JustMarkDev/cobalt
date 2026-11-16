/**
 * Grading for the MCP tool-use eval: plain checks on what the model called
 * and what it said last. No model grades another; every check is code.
 */

/** One tool call the model made, and what it got back. */
export type Call = {
  tool: string
  args: Record<string, unknown>
  isError: boolean
}

export type Trajectory = {
  calls: Array<Call>
  /** The model's last text, after its last tool call. */
  final: string
  stopReason: string | null
}

/** An argument check: equal, matching a pattern, or passing a test. */
type ArgCheck = unknown

/** A call the case expects, or forbids. Every named argument must match. */
export type CallMatch = {
  tool: string
  args?: Record<string, ArgCheck>
  /** Why this matters, for the report. */
  why?: string
}

export type Case = {
  id: string
  /** What the person asks. */
  prompt: string
  /** Each of these must be called at least once. */
  expect?: Array<CallMatch>
  /** None of these may be called. */
  forbid?: Array<CallMatch>
  /** The first tool call is to this tool. */
  first?: string
  /** These tools, if called, come in this order (first call of each). */
  order?: Array<string>
  /** At most this many tool calls. */
  maxCalls?: number
  /** The final answer must match each. */
  says?: Array<RegExp>
  /** The final answer must match none. */
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

/** Every check of the case against what happened. Empty means it passed. */
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
