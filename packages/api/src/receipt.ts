import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanLabel } from './via'
import type { Principal } from './auth'
import type { Receipt } from './via'

export type { Receipt } from './via'
export { cleanLabel, modelKey, serverReceipt } from './via'

export const TOOL_HEADER = 'cb-tool'
export const MODEL_HEADER = 'cb-model'

type Declared = {
  tool: string | null
  model: string | null
  machine?: string | null
  session?: boolean
}

export const declaredScope = new AsyncLocalStorage<Declared>()

export function declaredFrom(headers: Headers): Declared {
  return {
    tool: cleanLabel(headers.get(TOOL_HEADER)),
    model: cleanLabel(headers.get(MODEL_HEADER)),
  }
}

export function noteCaller(p: Principal) {
  const d = declaredScope.getStore()
  if (!d) return
  d.machine = p.device
  d.session = p.session
}

export function receiptFor(p?: Principal | null): Receipt {
  const d = declaredScope.getStore()
  const session = p ? p.session : (d?.session ?? false)
  return {
    machine: p ? p.device : (d?.machine ?? null),
    tool: d?.tool ?? (session ? 'cobalt' : null),
    model: d?.model ?? null,
  }
}
