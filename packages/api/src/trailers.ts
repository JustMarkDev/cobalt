import { cleanLabel } from './via'
import type { Receipt } from './via'

/**
 * The receipt of a `git push`. A push carries no `Cb-Tool` or `Cb-Model`
 * header, so the tool is `git push` and the model is whatever the commit
 * message itself declares, by the conventions agents already follow:
 *
 *   Assisted-by: claude-code:Claude Opus 5.5      (the Linux kernel's form)
 *   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
 *   Co-Authored-By: Codex <noreply@openai.com>
 *
 * Only a co-author with a model vendor's no-reply address counts, so a
 * person named as co-author is never mistaken for a model. Like the headers,
 * this is a declaration: it grants nothing.
 */
const ASSISTED = /^Assisted-by:[ \t]*(?:[^:\n]+:)?[ \t]*(.+?)[ \t]*$/im
const COAUTHOR =
  /^Co-Authored-By:[ \t]*(.+?)[ \t]*<noreply@(?:anthropic\.com|openai\.com)>[ \t]*$/im

/** The model a commit message declares, if any. */
export function declaredModelOf(message: string): string | null {
  const assisted = ASSISTED.exec(message)?.[1]
  if (assisted) return cleanLabel(assisted)
  const coauthor = COAUTHOR.exec(message)?.[1]
  return coauthor ? cleanLabel(coauthor) : null
}

/** The receipt for a patch set that arrived as a git push. */
export function pushReceipt(message: string | undefined): Receipt {
  return {
    machine: null,
    tool: 'git push',
    model: declaredModelOf(message ?? ''),
  }
}
