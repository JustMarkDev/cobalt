import { expect, test } from 'bun:test'
import { notesOf } from './notes'
import { aboutPatch, websiteOf } from './about'

test('release notes are sorted by their headings; checklists are not notes', () => {
  expect(
    notesOf(
      [
        '## Features',
        '* **ui:** dark mode ([#4](https://x/4))',
        '### Bug Fixes',
        '- **deps:** patch glib',
        '## Testing',
        '- [x] `bun test`',
        '- [ ] check macOS',
        "## What's Changed",
        '* Bump tauri by @dependabot[bot]',
      ].join('\n'),
    ),
  ).toEqual({
    added: ['**ui:** dark mode ([#4](https://x/4))'],
    changed: ['Bump tauri by @dependabot[bot]'],
    fixed: ['**deps:** patch glib'],
  })
  expect(notesOf('First stable release.\n\nGet the installer.')).toEqual({
    added: [],
    changed: ['First stable release.\n\nGet the installer.'],
    fixed: [],
  })
  expect(notesOf('  ')).toEqual({ added: [], changed: [], fixed: [] })
})

test("the provider's description, license and website never overwrite an edit made here", () => {
  const there = {
    description: 'Lyrics on top',
    license: 'GPL-3.0',
    website: 'https://example.com',
  }
  // Empty here, or the old placeholder: copied.
  expect(
    aboutPatch(
      {
        description: 'Linked to github.com/o/r',
        license: null,
        website: null,
      },
      there,
      null,
    ),
  ).toEqual(there)
  // Edited here: kept. Still what the provider said before: follows it.
  expect(
    aboutPatch(
      { description: 'Mine', license: 'MIT', website: 'https://old.dev' },
      there,
      { description: 'Old', license: 'MIT', website: 'old.dev' },
    ),
  ).toEqual({ license: 'GPL-3.0', website: 'https://example.com' })
  expect(aboutPatch(there, there, null)).toBeNull()
  expect(websiteOf('cobaltforge.dev')).toBe('https://cobaltforge.dev')
  expect(websiteOf('not a site')).toBeNull()
})
