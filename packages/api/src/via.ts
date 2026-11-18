/**
 * The receipt every write keeps (see `receipt.ts` for how a request fills
 * it in). Plain functions with no Node imports, so the Convex functions use
 * them too.
 */
export type Receipt = {
  machine: string | null
  tool: string | null
  model: string | null
}

/**
 * A declared label, cleaned: printable text, single spaces, at most 80
 * characters. Anything else is dropped rather than stored, so a receipt can
 * never carry markup, control characters or a wall of text.
 */
export function cleanLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s || s.length > 80) return null
  // Letters, digits, and the punctuation model and tool names use.
  if (!/^[\p{L}\p{N} ._:+/()@-]+$/u.test(s)) return null
  return s
}

/** A receipt for something the server did on its own, such as landing by itself. */
export function serverReceipt(tool: string): Receipt {
  return { machine: null, tool, model: null }
}

/** A model name in the form repositories compare: lowercase, single spaces. */
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Declined models as stored: trimmed, one per model however it is spelled. */
export function normalizeModels(list: ReadonlyArray<string>): Array<string> {
  const seen = new Map<string, string>()
  for (const m of list) {
    const name = m.replace(/\s+/g, ' ').trim()
    if (name) seen.set(modelKey(name), name)
  }
  return [...seen.values()]
}

/**
 * Why an account may not contribute here, or null when it may. The same rule
 * in both backends: a denounced account opens nothing; a change declared with
 * a declined model is turned away.
 */
export function contributionRefusal(
  repo: {
    owner: string
    name: string
    denounced?: ReadonlyArray<{ handle: string; reason: string }> | null
    declinedModels?: ReadonlyArray<string> | null
  },
  handle: string,
  model: string | null,
  what: 'change' | 'issue',
): { code: 'denounced' | 'model_declined'; detail: string } | null {
  const d = repo.denounced?.find((x) => x.handle === handle.toLowerCase())
  if (d)
    return {
      code: 'denounced',
      detail: `${handle} may not open ${what}s in ${repo.owner}/${repo.name}: ${d.reason}`,
    }
  if (
    what === 'change' &&
    model &&
    (repo.declinedModels ?? []).some((m) => modelKey(m) === modelKey(model))
  )
    return {
      code: 'model_declined',
      detail: `${repo.owner}/${repo.name} takes no changes declared as ${model}.`,
    }
  return null
}
