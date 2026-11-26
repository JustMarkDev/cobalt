import { expect, test } from 'bun:test'
import { assetTarget } from './assets'

test('release files are matched to the computer they install on', () => {
  expect(assetTarget('Music.Companion_2.5.2_universal.dmg')).toEqual({
    platform: 'macos',
    arch: 'universal',
  })
  expect(assetTarget('Music.Companion_2.5.2_x64-setup.exe')).toEqual({
    platform: 'windows',
    arch: 'x64',
  })
  expect(assetTarget('Music.Companion_2.5.2_x64_en-US.msi')).toEqual({
    platform: 'windows',
    arch: 'x64',
  })
  expect(assetTarget('app_1.0.0_amd64.deb')).toEqual({
    platform: 'linux',
    arch: 'x64',
  })
  expect(assetTarget('app-linux-aarch64.AppImage')).toEqual({
    platform: 'linux',
    arch: 'arm64',
  })
  // Updater payloads, signatures and manifests are nobody's download.
  for (const n of [
    'latest.json',
    'Music.Companion_2.5.2_universal.app.tar.gz',
    'Music.Companion_2.5.2_universal.app.tar.gz.sig',
    'Music.Companion_2.5.2_x64-setup.exe.sig',
    'SHA256SUMS',
    'checksums.txt',
    'source.zip',
  ])
    expect(assetTarget(n)).toBeNull()
})
