// Release notes from a provider, sorted into what was added, changed and fixed.

export type Notes = {
  added: Array<string>
  changed: Array<string>
  fixed: Array<string>
}

/**
 * Release notes sorted the way they are written: the bullets under a
 * "Features" heading are added, under "Bug fixes" fixed, the rest changed.
 * Checklists are a pull request's to-do, not a note. Notes with no bullets
 * are one note. The text as written is kept as well (`body`).
 */
export function notesOf(body: string): Notes {
  const notes: Notes = { added: [], changed: [], fixed: [] }
  let section: keyof Notes = 'changed'
  for (const l of body.split('\n')) {
    const h = /^\s*#{1,6}\s+(.+)$/.exec(l)?.[1]
    if (h) {
      section = /fix|bug|patch/i.test(h)
        ? 'fixed'
        : /feat|add|new/i.test(h)
          ? 'added'
          : 'changed'
      continue
    }
    const item = /^\s*[-*+]\s+(?!\[[ xX]\]\s)(.+)$/.exec(l)?.[1]?.trim()
    if (item) notes[section].push(item.slice(0, 5000))
  }
  if (!notes.added.length && !notes.changed.length && !notes.fixed.length) {
    const t = body.trim()
    if (t) notes.changed.push(t.slice(0, 5000))
  }
  for (const k of ['added', 'changed', 'fixed'] as const)
    notes[k] = notes[k].slice(0, 200)
  return notes
}
