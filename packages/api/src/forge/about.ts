// What a linked repository says about itself on its provider, copied onto the
// repository here. Shared by both stores so they decide the same way.

export type About = {
  description: string
  license: string | null
  website: string | null
}

/** A website as the provider gave it, made a link: `example.com` has no scheme. */
export function websiteOf(w: string | null): string | null {
  const t = w?.trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`
  return null
}

export const aboutOf = (m: {
  description: string
  license: string | null
  website: string | null
}): About => ({
  description: m.description.trim().slice(0, 500),
  license: m.license,
  website: websiteOf(m.website),
})

/** The description an import used to write when the provider had none. */
const PLACEHOLDER = /^Linked to \S+\/\S+$/

/**
 * The fields to change on the repository here, or null. A field is copied
 * when it is empty here, or still holds what the provider said before
 * (`was`): an edit made here is never overwritten.
 */
export function aboutPatch(
  here: About,
  there: About,
  was: About | null,
): Partial<About> | null {
  const out: Partial<About> = {}
  const free = (k: keyof About) => {
    const v = here[k]
    if (v === null || v === '') return true
    if (k === 'description' && PLACEHOLDER.test(v)) return true
    return was !== null && v === aboutOf(was)[k]
  }
  for (const k of ['description', 'license', 'website'] as const)
    if (here[k] !== there[k] && free(k)) Object.assign(out, { [k]: there[k] })
  return Object.keys(out).length ? out : null
}
