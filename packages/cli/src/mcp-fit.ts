/**
 * Keeps MCP answers small enough for an agent's context. A tool result is
 * read on every later turn, and clients refuse very large ones outright
 * (Claude Code saves a result over its limit to a file instead of showing
 * it). Each answer is compact JSON (the CLI's indentation is a quarter to a
 * third of its size) and stays under about 30,000 characters. Long lists keep
 * the part the agent most likely wants and say how to read the rest; text is
 * never cut in the middle of a JSON value.
 */

/** About 7,500 tokens. */
export const MCP_BUDGET = 30_000

/** Timeline entries returned when the caller does not say. */
export const TIMELINE_LIMIT = 50

type Timeline = { id: string; entries: Array<unknown> }

const entries = (n: number) => (n === 1 ? 'the entry' : `the ${n} entries`)

/**
 * A page of a timeline, newest entries first chosen, oldest first shown.
 * `before` is an entry position from an earlier answer: entries before it.
 */
export function pageTimeline(
  text: string,
  o: { limit?: number; before?: number; budget?: number } = {},
): string {
  let t: Timeline
  try {
    t = JSON.parse(text) as Timeline
  } catch {
    return fitText(text, o.budget)
  }
  if (!Array.isArray(t.entries)) return fitText(text, o.budget)
  const total = t.entries.length
  const end = Math.min(Math.max(o.before ?? total, 0), total)
  let start = Math.max(0, end - Math.max(1, o.limit ?? TIMELINE_LIMIT))
  const make = (from: number) => ({
    id: t.id,
    total,
    // Positions of the entries shown: entries[i] is position from + i.
    from,
    entries: t.entries.slice(from, end),
    earlier:
      from > 0
        ? {
            count: from,
            hint: `Pass before: ${from} for ${entries(Math.min(from, o.limit ?? TIMELINE_LIMIT))} before these.`,
          }
        : null,
  })
  let page = JSON.stringify(make(start))
  // Over budget: drop the oldest of the page, keeping at least one entry.
  while (page.length > (o.budget ?? MCP_BUDGET) && start < end - 1) {
    start += Math.max(1, Math.floor((end - start) / 8))
    start = Math.min(start, end - 1)
    page = JSON.stringify(make(start))
  }
  if (page.length <= (o.budget ?? MCP_BUDGET)) return page
  // One entry alone is over the budget: keep the page and its cursor, and say
  // so in place of the entry.
  return JSON.stringify({
    ...make(start),
    entries: [],
    cut: `The entry at position ${start} is too large to show (${JSON.stringify(t.entries[start]).length} characters).`,
  })
}

type Context = {
  openChanges?: Array<unknown>
  openIssues?: Array<unknown>
}

/** The context's lists stop at 50; say so, and where the rest is. */
export function noteContextLimits(text: string, cap = 50): string {
  let c: Context & Record<string, unknown>
  try {
    c = JSON.parse(text) as Context & Record<string, unknown>
  } catch {
    return fitText(text)
  }
  const more: Array<string> = []
  if ((c.openChanges?.length ?? 0) >= cap)
    more.push(
      `openChanges shows the ${cap} most recently updated; list_changes has them all.`,
    )
  if ((c.openIssues?.length ?? 0) >= cap)
    more.push(`openIssues shows the ${cap} newest; list_issues has them all.`)
  return fitText(more.length ? JSON.stringify({ ...c, more }) : text)
}

/**
 * Any answer over the budget: shorten its longest list from the end until it
 * fits, and say how many were left out. Text that is not JSON is cut, with a
 * note.
 */
export function fitText(text: string, budget = MCP_BUDGET): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    if (text.length <= budget) return text
    return `${text.slice(0, budget - 200)}\n… cut: the answer was ${text.length} characters. Ask for less (a filter, a limit or one item).`
  }
  // The CLI indents its JSON for people; an agent pays for every space.
  const compact = JSON.stringify(value)
  if (compact.length <= budget) return compact
  text = compact
  // Every list in the answer; the longest is the one to shorten.
  const lists: Array<Array<unknown>> = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      lists.push(v)
      v.forEach(walk)
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(value)
  const size = (x: unknown) => JSON.stringify(x).length
  const list = lists.sort((a, b) => size(b) - size(a)).at(0)
  if (!list || list.length < 2)
    return shortenStrings(value, budget, text.length)
  const full = list.length
  let keep = full
  let out = text
  while (out.length > budget && keep > 1) {
    keep = Math.max(1, Math.floor(keep * 0.8))
    const note = `${full - keep} of ${full} left out to fit. Ask for less (a filter, a limit or one item).`
    out = JSON.stringify(
      value === list
        ? { data: list.slice(0, keep), omitted: note }
        : replace(value, list, list.slice(0, keep), note),
    )
  }
  // One item can still be too big: its long text is what goes.
  return out.length <= budget
    ? out
    : shortenStrings(JSON.parse(out), budget, text.length)
}

/**
 * Shortens the longest strings, saying how long each was, until the answer
 * fits; failing that, says the answer was too large.
 */
function shortenStrings(value: unknown, budget: number, was: number) {
  let v = value
  for (let round = 0; round < 64; round++) {
    const out = JSON.stringify(v)
    if (out.length <= budget) return out
    let longest = ''
    const find = (x: unknown) => {
      if (typeof x === 'string') {
        if (x.length > longest.length) longest = x
      } else if (Array.isArray(x)) x.forEach(find)
      else if (x && typeof x === 'object') Object.values(x).forEach(find)
    }
    find(v)
    if (longest.length < 400) break
    const keep = Math.max(200, longest.length - (out.length - budget) - 200)
    const cut = `${longest.slice(0, keep)}… [cut: ${longest.length} characters]`
    const swap = (x: unknown): unknown =>
      x === longest
        ? cut
        : Array.isArray(x)
          ? x.map(swap)
          : x && typeof x === 'object'
            ? Object.fromEntries(
                Object.entries(x).map(([k, y]) => [k, swap(y)]),
              )
            : x
    v = swap(v)
  }
  return JSON.stringify({
    cut: true,
    note: `The answer was ${was} characters, over the ${budget} an agent can take. Ask for less (a filter, a limit or one item).`,
  })
}

/** `value` with `list` replaced by `shortened`, and a note beside it. */
function replace(
  value: unknown,
  list: Array<unknown>,
  shortened: Array<unknown>,
  note: string,
): unknown {
  if (value === list) return shortened
  if (Array.isArray(value))
    return value.map((x) => replace(x, list, shortened, note))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(value)) {
      out[k] = replace(x, list, shortened, note)
      if (x === list) out[`${k}_omitted`] = note
    }
    return out
  }
  return value
}

const SAFE = Number.MAX_SAFE_INTEGER

/**
 * A JSON Schema as a model needs it: without the `$schema` line every tool
 * repeats, and without the ±(2^53 - 1) bounds an integer gets, which only say
 * "a number". Validation is unchanged: it still runs on the full schema.
 */
export function compactJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactJsonSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema') continue
    if (k === 'minimum' && v === -SAFE) continue
    if (k === 'maximum' && v === SAFE) continue
    out[k] = compactJsonSchema(v)
  }
  return out
}

type JsonSchemaOf = {
  input: (o: unknown) => unknown
  output: (o: unknown) => unknown
}

/**
 * The schema with what it advertises compacted. The MCP SDK lists a tool's
 * input through the standard `~standard.jsonSchema`, so that is the one place
 * to change; parsing goes through `~standard.validate`, which is kept.
 */
export function advertiseCompact<T extends object>(schema: T): T {
  const std = (schema as { '~standard': { jsonSchema?: JsonSchemaOf } })[
    '~standard'
  ]
  const js = std.jsonSchema
  if (!js) return schema
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    value: {
      ...std,
      jsonSchema: {
        input: (o: unknown) => compactJsonSchema(js.input(o)),
        output: (o: unknown) => compactJsonSchema(js.output(o)),
      },
    },
  })
  return schema
}
