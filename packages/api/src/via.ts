export type Receipt = {
  machine: string | null
  tool: string | null
  model: string | null
}

export function cleanLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s || s.length > 80) return null
  if (!/^[\p{L}\p{N} ._:+/()@-]+$/u.test(s)) return null
  return s
}

export function serverReceipt(tool: string): Receipt {
  return { machine: null, tool, model: null }
}

export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function normalizeModels(list: ReadonlyArray<string>): Array<string> {
  const seen = new Map<string, string>()
  for (const m of list) {
    const name = m.replace(/\s+/g, ' ').trim()
    if (name) seen.set(modelKey(name), name)
  }
  return [...seen.values()]
}

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
