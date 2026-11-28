import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CLI_RELEASES, installPs1, installSh } from './install-script'

describe('install script', () => {
  test('is valid sh and points at the CLI releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'))
    const file = join(dir, 'install.sh')
    writeFileSync(file, installSh('https://cobaltforge.dev'))
    const p = Bun.spawnSync(['sh', '-n', file])
    expect(p.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain(
      `${CLI_RELEASES}/latest/download`,
    )
    expect(installPs1('https://cobaltforge.dev')).toContain(
      'cb-windows-x64.exe',
    )
  })

  test('installs a checked binary, and refuses one that does not match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'))
    const bin = '#!/bin/sh\necho 9.9.9\n'
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const asset = `cb-${os}-${arch}`
    // A fake curl serves the "release" from files.
    const fake = join(dir, 'fakebin')
    Bun.spawnSync(['mkdir', '-p', fake, join(dir, 'rel')])
    writeFileSync(join(dir, 'rel', asset), bin)
    const sum = (s: string) => createHash('sha256').update(s).digest('hex')
    writeFileSync(
      join(fake, 'curl'),
      `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
cp "${dir}/rel/$(basename "$url")" "$out"
`,
    )
    Bun.spawnSync(['chmod', '+x', join(fake, 'curl')])
    const script = join(dir, 'install.sh')
    writeFileSync(script, installSh('https://cobaltforge.dev'))
    const run = () =>
      Bun.spawnSync(['sh', script], {
        env: {
          PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: dir,
          SHELL: '/bin/zsh',
          CB_INSTALL: join(dir, 'bin'),
        },
      })
    writeFileSync(join(dir, 'rel', 'SHA256SUMS'), `${sum('other')}  ${asset}\n`)
    const bad = run()
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr.toString()).toContain('checksum')

    writeFileSync(join(dir, 'rel', 'SHA256SUMS'), `${sum(bin)}  ${asset}\n`)
    const good = run()
    expect(good.stderr.toString()).not.toContain('cb install:')
    expect(good.exitCode).toBe(0)
    expect(good.stdout.toString()).toContain('Installed 9.9.9')
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain(
      join(dir, 'bin'),
    )
    // Twice: the PATH line is not added again.
    run()
    expect(
      readFileSync(join(dir, '.zshrc'), 'utf8').split('# cobalt').length,
    ).toBe(2)
  })
})
