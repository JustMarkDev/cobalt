// Builds cb for every platform into dist/cli, with SHA256SUMS: the files a
// CLI release (tag cli-v<version>) carries and install.sh downloads.
//   bun scripts/cli-release.ts            all targets
//   bun scripts/cli-release.ts --host     only this machine's, for a local try
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const out = join(root, 'dist', 'cli')
const { version } = JSON.parse(
  readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
) as { version: string }
const help = readFileSync(join(root, 'packages/cli/src/help.ts'), 'utf8')
if (!help.includes(`export const version = '${version}'`))
  throw new Error(
    `packages/cli/src/help.ts does not say version ${version}, as package.json does.`,
  )

const all = [
  ['darwin-arm64', 'bun-darwin-arm64'],
  ['darwin-x64', 'bun-darwin-x64'],
  ['linux-arm64', 'bun-linux-arm64'],
  ['linux-x64', 'bun-linux-x64'],
  ['windows-x64', 'bun-windows-x64'],
] as const
const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const targets = process.argv.includes('--host')
  ? all.filter(([name]) => name === host)
  : all

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const sums: Array<string> = []
for (const [name, target] of targets) {
  const file = `cb-${name}${name.startsWith('windows') ? '.exe' : ''}`
  const p = Bun.spawnSync(
    [
      'bun',
      'build',
      'packages/cli/src/main.ts',
      '--compile',
      '--minify',
      `--target=${target}`,
      '--outfile',
      join(out, file),
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  )
  if (p.exitCode !== 0) throw new Error(`Building ${file} failed.`)
  const hash = createHash('sha256')
    .update(readFileSync(join(out, file)))
    .digest('hex')
  sums.push(`${hash}  ${file}`)
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`cb ${version}: ${targets.length} binaries in dist/cli`)
