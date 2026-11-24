import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanLabel } from './via'
import type { Principal } from './auth'
import type { Receipt } from './via'

/**
 * Every write keeps a receipt: the machine the login was made on, the tool
 * that sent the request and the model it says it used. The account stays the
 * one responsible; the receipt says how the write got here.
 *
 * Tool and model are what the client declares in the `Cb-Tool` and `Cb-Model`
 * headers. cobalt hosts no model and cannot check either, so they are
 * labels: they grant nothing. A repository may still decline changes declared
 * with a given model, which stops tools that report honestly.
 */
export type { Receipt } from './via'
export { cleanLabel, modelKey, serverReceipt } from './via'

export const TOOL_HEADER = 'cb-tool'
export const MODEL_HEADER = 'cb-model'

/**
 * What the client declared for this request, and the machine of the login
 * that sent it, filled in once the token is known.
 */
type Declared = {
  tool: string | null
  model: string | null
  machine?: string | null
  session?: boolean
}

export const declaredScope = new AsyncLocalStorage<Declared>()

/** The labels a request declared, from its headers. */
export function declaredFrom(headers: Headers): Declared {
  return {
    tool: cleanLabel(headers.get(TOOL_HEADER)),
    model: cleanLabel(headers.get(MODEL_HEADER)),
  }
}

/** Remembers who is calling, so receipts made deeper down know the machine. */
export function noteCaller(p: Principal) {
  const d = declaredScope.getStore()
  if (!d) return
  d.machine = p.device
  d.session = p.session
}

/**
 * The receipt for a write in the current request. With a principal, its
 * machine; otherwise the caller noted for the request; outside any request
 * (a timer, the server itself), no machine at all.
 */
export function receiptFor(p?: Principal | null): Receipt {
  const d = declaredScope.getStore()
  const session = p ? p.session : (d?.session ?? false)
  return {
    machine: p ? p.device : (d?.machine ?? null),
    tool: d?.tool ?? (session ? 'cobalt' : null),
    model: d?.model ?? null,
  }
}
