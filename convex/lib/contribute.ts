import { contributionRefusal } from '@cobaltforge/api/via'
import { fail } from './errors'
import type { Actor } from './actor'
import type { Doc } from '../_generated/dataModel'

/** The repository's own rules on who and what it takes, as the API has them. */
export function assertMayContribute(
  repo: Doc<'repos'>,
  p: Actor,
  what: 'change' | 'issue',
) {
  const no = contributionRefusal(repo, p.handle, p.via.model, what)
  if (no) fail(no.code, no.detail)
}
