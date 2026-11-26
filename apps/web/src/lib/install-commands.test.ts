import { describe, expect, test } from 'bun:test'
import { installsFor, ownerInstalls, readmeInstalls } from './install-commands'

describe('install commands', () => {
  test('a desktop app whose README only links to downloads has none', () => {
    const readme = [
      '## Install',
      '',
      'Download the Windows `.exe` or the universal macOS `.dmg` from the',
      '[latest release](https://example.com/releases/latest).',
      '',
      '## Contributing',
      '',
      '```sh',
      'bun install',
      'bun run tauri build',
      '```',
    ].join('\n')
    expect(readmeInstalls(readme)).toEqual([])
    expect(installsFor(null, readme)).toEqual([])
  })

  test('commands in the README are found, and build steps are not', () => {
    const readme = [
      '# tool',
      '## Installation',
      '```bash',
      '$ brew install acme/tap/tool',
      '# or',
      'cargo install tool --locked',
      'npm install',
      'curl -fsSL https://tool.dev/install.sh | sh',
      '```',
      '```powershell',
      'winget install Acme.Tool',
      '```',
      '## Building from source',
      '```',
      'cargo install --path .',
      'docker run --rm builder',
      '```',
    ].join('\n')
    expect(readmeInstalls(readme)).toEqual([
      { label: 'brew', command: 'brew install acme/tap/tool' },
      { label: 'cargo', command: 'cargo install tool --locked' },
      {
        label: 'script',
        command: 'curl -fsSL https://tool.dev/install.sh | sh',
      },
      { label: 'winget', command: 'winget install Acme.Tool' },
    ])
  })

  test("the owners' commands win over the README", () => {
    const readme = '```\nbrew install other\n```'
    expect(
      installsFor('winget install Me.App\n\nmytool get app', readme),
    ).toEqual([
      { label: 'winget', command: 'winget install Me.App' },
      { label: 'mytool', command: 'mytool get app' },
    ])
    expect(installsFor('  ', readme)).toEqual([
      { label: 'brew', command: 'brew install other' },
    ])
    expect(ownerInstalls(null)).toEqual([])
  })

  test('one tab per tool', () => {
    const readme = '```\nbrew install a\nbrew install --cask a\n```'
    expect(readmeInstalls(readme)).toEqual([
      { label: 'brew', command: 'brew install a' },
    ])
  })
})
