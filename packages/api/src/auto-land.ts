import { isSensitivePath } from './sensitive'
import type { DomainPort } from './domain/port'

export async function tryAutoLand(
  d: DomainPort,
  owner: string,
  name: string,
  ref: string,
): Promise<boolean> {
  try {
    const ready = await d.autoLandCandidate(owner, name, ref)
    if (!ready) return false
    if (await touchesProtected(d, ready.full, ready.base, ready.sha))
      return false
    return await d.autoLand(owner, name, ref, ready.sha)
  } catch {
    return false
  }
}

async function touchesProtected(
  d: DomainPort,
  full: string,
  base: string,
  head: string,
): Promise<boolean> {
  const git = d.svc.git
  const [before, after] = await Promise.all([
    git.files(full, base),
    git.files(full, head),
  ])
  if (before.complete !== true || after.complete !== true) return true
  const paths = new Set(
    [...before.paths, ...after.paths].filter(isSensitivePath),
  )
  for (const path of paths) {
    const [a, b] = await Promise.all([
      git.blob(full, path, before.ref),
      git.blob(full, path, after.ref),
    ])
    if (!a || !b || !sameBytes(a, b)) return true
  }
  return false
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
