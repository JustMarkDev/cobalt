/**
 * An Idempotency-Key's row, if `lease` still holds it. Each request that
 * takes a key draws a lease; a request whose lease was taken over (it went
 * quiet past `LEASE_MS`) may no longer write under the key, finish it or
 * give it up. A row from before leases were kept has none, and is held by
 * whoever holds its key.
 */
export function heldBy<T extends { lease?: string }>(
  row: T | null,
  lease: string | undefined,
): row is T {
  return row !== null && (row.lease === undefined || row.lease === lease)
}
