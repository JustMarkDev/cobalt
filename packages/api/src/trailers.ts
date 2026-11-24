import { cleanLabel } from './via'
import type { Receipt } from './via'

const ASSISTED = /^Assisted-by:[ \t]*(?:[^:\n]+:)?[ \t]*(.+?)[ \t]*$/im
const COAUTHOR =
  /^Co-Authored-By:[ \t]*(.+?)[ \t]*<noreply@(?:anthropic\.com|openai\.com)>[ \t]*$/im

export function declaredModelOf(message: string): string | null {
  const assisted = ASSISTED.exec(message)?.[1]
  if (assisted) return cleanLabel(assisted)
  const coauthor = COAUTHOR.exec(message)?.[1]
  return coauthor ? cleanLabel(coauthor) : null
}

export function pushReceipt(message: string | undefined): Receipt {
  return {
    machine: null,
    tool: 'git push',
    model: declaredModelOf(message ?? ''),
  }
}
