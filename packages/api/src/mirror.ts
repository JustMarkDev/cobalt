import { iso } from './domain/records'
import type { z } from 'zod'
import type { MirrorRec } from './extras'
import type * as S from './schemas'

export const presentMirror = (
  apiBase: string,
  full: string,
  m: MirrorRec,
): z.infer<typeof S.Mirror> => ({
  object: 'mirror',
  id: m.id,
  host: m.host,
  slug: m.slug,
  direction: m.direction,
  state: m.state,
  detail: m.detail,
  last_sync_at: iso(m.lastSync),
  url: `${apiBase}/repos/${full}/mirrors/${m.id}`,
  created_at: iso(m.created),
  paused: m.paused ?? false,
})
