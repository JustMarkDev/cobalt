export const MCP_BUDGET = 30_000

export const TIMELINE_LIMIT = 50

type Timeline = { id: string; entries: Array<unknown> }

const entries = (n: number) => (n === 1 ? 'the entry' : `the ${n} entries`)

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
  while (page.length > (o.budget ?? MCP_BUDGET) && start < end - 1) {
    start += Math.max(1, Math.floor((end - start) / 8))
    start = Math.min(start, end - 1)
    page = JSON.stringify(make(start))
  }
  if (page.length <= (o.budget ?? MCP_BUDGET)) return page
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

export function fitText(text: string, budget = MCP_BUDGET): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    if (text.length <= budget) return text
    return `${text.slice(0, budget - 200)}\n… cut: the answer was ${text.length} characters. Ask for less (a filter, a limit or one item).`
  }
  const compact = JSON.stringify(value)
  if (compact.length <= budget) return compact
  text = compact
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
  return out.length <= budget
    ? out
    : shortenStrings(JSON.parse(out), budget, text.length)
}

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
