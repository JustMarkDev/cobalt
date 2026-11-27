// cb upgrade: the latest released cb in place of this one, checked against
// the release's SHA-256 sums. Only for the installed binary: from source or
// npm, it says how to update instead.
import { createHash } from 'node:crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { CbError, exit, print } from '../output'
import { str } from '../args'
import { version } from '../help'
import type { Command } from './types'

const RELEASES = 'https://github.com/JustMarkDev/cobalt/releases'

export const assetFor = (platform: string, arch: string) =>
  `cb-${platform === 'win32' ? 'windows' : platform}-${arch}${platform === 'win32' ? '.exe' : ''}`

const get = async (url: string) => {
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok)
    throw new CbError(
      'download_failed',
      `Could not download ${url} (${r.status}).`,
      'Check the network, or pass --to with a released version.',
    )
  return r
}

export const upgrade: Command = async ({ flags }, ctx) => {
  if (!Bun.isStandaloneExecutable)
    throw new CbError(
      'not_installed_binary',
      'This cb runs from source, so it is updated the way it was installed.',
      'From npm: bun update -g @cobaltforge/cli. From a checkout: git pull.',
      exit.usage,
    )
  const want = str(flags, 'to')?.replace(/^v/, '')
  const base = want
    ? `${RELEASES}/download/cli-v${want}`
    : `${RELEASES}/latest/download`
  // The latest release's tag says its version without downloading it.
  const tag = want ? null : (await get(`${RELEASES}/latest`)).url
  const latest = want ?? /\/tag\/cli-v([^/?#]+)/.exec(tag ?? '')?.[1]
  if (!latest)
    throw new CbError(
      'no_release',
      'There is no cb release to upgrade to yet.',
      `See ${RELEASES}.`,
    )
  if (latest === version && !want) {
    print(
      ctx,
      { version, upgraded: false },
      () => `cb ${version} is the latest.`,
    )
    return
  }
  const asset = assetFor(process.platform, process.arch)
  if (flags['dry-run'] === true) {
    print(
      ctx,
      { from: version, to: latest, asset, dryRun: true },
      () => `would replace cb ${version} with ${latest}`,
    )
    return
  }
  const [bin, sums] = await Promise.all([
    get(`${base}/${asset}`).then((r) => r.arrayBuffer()),
    get(`${base}/SHA256SUMS`).then((r) => r.text()),
  ])
  const expected = sums
    .split('\n')
    .find((l) => l.endsWith(`  ${asset}`))
    ?.split(' ')[0]
  const actual = createHash('sha256').update(Buffer.from(bin)).digest('hex')
  if (!expected || expected !== actual)
    throw new CbError(
      'checksum_mismatch',
      'The download does not match its checksum; nothing was changed.',
      'Try again later.',
    )
  // Write beside it, then swap: a running binary can be renamed, even on Windows.
  const self = process.execPath
  const next = `${self}.new`
  const old = `${self}.old`
  writeFileSync(next, Buffer.from(bin))
  chmodSync(next, 0o755)
  rmSync(old, { force: true })
  renameSync(self, old)
  renameSync(next, self)
  if (process.platform !== 'win32') rmSync(old, { force: true })
  print(
    ctx,
    { from: version, to: latest, path: self, upgraded: true },
    () => `cb ${version} → ${latest} (${self})`,
  )
}
