import { print, table } from './output'
import type { Ctx } from './output'

type Entry = {
  kind: string
  created_at: string
  actor: { handle: string } | null
  via: {
    machine: string | null
    tool: string | null
    model: string | null
  } | null
  summary: string
}

/** A receipt in a few words: `T3 Code · Claude Opus 5.5 on Laptop`. */
export function receipt(
  via: {
    machine: string | null
    tool: string | null
    model: string | null
  } | null,
) {
  if (!via) return '-'
  const what = [via.tool, via.model].filter(Boolean).join(' · ')
  const where =
    via.machine && via.machine !== 'browser' ? ` on ${via.machine}` : ''
  return `${what || '-'}${where}`
}

/** Every entry of a change's or an issue's timeline, oldest first. */
export async function showTimeline(ctx: Ctx, path: string, id: string) {
  const api = ctx.api()
  const entries: Array<Entry> = []
  let cursor: string | undefined
  // A timeline is tens of entries; the cap only guards against a loop.
  for (let i = 0; i < 50; i++) {
    const r = await api.get(path, { query: { limit: 200, cursor } })
    entries.push(...(r.json.data as Array<Entry>))
    cursor = r.json.next_cursor ?? undefined
    if (!cursor) break
  }
  print(ctx, { id, entries }, () =>
    table(
      entries.map((e) => [
        e.created_at.slice(0, 16).replace('T', ' '),
        e.kind,
        e.actor?.handle ?? '-',
        receipt(e.via),
        e.summary,
      ]),
      ['WHEN', 'KIND', 'WHO', 'VIA', 'WHAT'],
    ),
  )
}
