export type Position = { key: string | number; id: string }

export type Ranges<D> = {
  sameKey: (key: string | number, id: string) => AsyncIterable<D>
  beyond: (key: string | number | null) => AsyncIterable<D>
}

export async function keysetPage<D extends { publicId: string }>(
  ranges: Ranges<D>,
  keyOf: (d: D) => string | number,
  opts: {
    after: Position | null
    limit: number
    match?: (d: D) => boolean | Promise<boolean>
    maxScan?: number
  },
): Promise<{ items: Array<D>; next: Position | null }> {
  const items: Array<D> = []
  let more = false
  let scanned = 0
  const maxScan = opts.maxScan ?? 10_000
  const sources = opts.after
    ? [
        ranges.sameKey(opts.after.key, opts.after.id),
        ranges.beyond(opts.after.key),
      ]
    : [ranges.beyond(null)]
  outer: for (const source of sources)
    for await (const d of source) {
      if (++scanned > maxScan) break outer
      if (opts.match && !(await opts.match(d))) continue
      if (items.length === opts.limit) {
        more = true
        break outer
      }
      items.push(d)
    }
  const last = items.at(-1)
  return {
    items,
    next: more && last ? { key: keyOf(last), id: last.publicId } : null,
  }
}
