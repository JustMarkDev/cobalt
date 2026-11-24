export function heldBy<T extends { lease?: string }>(
  row: T | null,
  lease: string | undefined,
): row is T {
  return row !== null && (row.lease === undefined || row.lease === lease)
}
