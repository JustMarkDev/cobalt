import { expect, test } from 'bun:test'
import { LICENSE_FILES, languagesOf, licenseOf } from './detect'

test('languages by share of the files, vendored code left out', () => {
  expect(
    languagesOf([
      { path: 'src/a.ts' },
      { path: 'src/b.tsx' },
      { path: 'rust/src/main.rs' },
      { path: 'README.md' },
      { path: 'node_modules/x/index.js' },
      { path: 'web/style.css' },
    ]),
  ).toEqual([
    ['TypeScript', 50],
    ['CSS', 25],
    ['Rust', 25],
  ])
  expect(languagesOf([{ path: 'README.md' }])).toEqual([])
})

test('licenses by their text', () => {
  expect(
    licenseOf(
      'MIT License\n\nPermission is hereby granted, free of charge, to any person',
    ),
  ).toBe('MIT')
  expect(licenseOf('Apache License\nVersion 2.0, January 2004')).toBe(
    'Apache-2.0',
  )
  expect(
    licenseOf('GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007'),
  ).toBe('GPL-3.0')
  expect(
    licenseOf(
      'Redistribution and use in source and binary forms ... Neither the name',
    ),
  ).toBe('BSD-3-Clause')
  expect(licenseOf('All rights reserved.')).toBe(null)
  expect(
    ['LICENSE', 'LICENSE.md', 'licence.txt', 'COPYING'].every((f) =>
      LICENSE_FILES.test(f),
    ),
  ).toBe(true)
  expect(LICENSE_FILES.test('LICENSE-THIRD-PARTY.md')).toBe(false)
})
