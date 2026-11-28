// What a repository made here is written in and under which license, read
// from its own files (an imported one takes both from its provider).

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  rs: 'Rust',
  py: 'Python',
  go: 'Go',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  scala: 'Scala',
  dart: 'Dart',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  lua: 'Lua',
  zig: 'Zig',
  nim: 'Nim',
  ml: 'OCaml',
  clj: 'Clojure',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  sql: 'SQL',
  r: 'R',
  jl: 'Julia',
  sol: 'Solidity',
  tf: 'HCL',
}

/** Folders that hold other people's code or build output, not the project's. */
const VENDORED =
  /(^|\/)(node_modules|vendor|third_party|dist|build|target|out|\.next|coverage)\//

/**
 * The languages of a repository by how much of it each makes up (bytes when
 * known, else files), largest first, in percent with one decimal.
 */
export function languagesOf(
  files: ReadonlyArray<{ path: string; bytes?: number }>,
): Array<[string, number]> {
  const by = new Map<string, number>()
  for (const f of files) {
    if (VENDORED.test(f.path)) continue
    const ext = /\.([A-Za-z0-9]+)$/.exec(f.path)?.[1]?.toLowerCase()
    const lang = ext ? LANGUAGES[ext] : undefined
    if (!lang) continue
    by.set(lang, (by.get(lang) ?? 0) + Math.max(1, f.bytes ?? 1))
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0)
  if (!total) return []
  return [...by]
    .map(([l, n]): [string, number] => [l, Math.round((n / total) * 1000) / 10])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Files a license is kept in, most usual first. */
export const LICENSE_FILES =
  /^(licen[cs]e|copying|unlicense)(\.(md|txt|markdown|rst))?$/i

/** The SPDX id of a license text, or null when it is not one we know. */
export function licenseOf(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').toLowerCase()
  const has = (s: string) => t.includes(s)
  if (has('gnu affero general public license'))
    return has('version 3') ? 'AGPL-3.0' : 'AGPL'
  if (has('gnu lesser general public license'))
    return has('version 3')
      ? 'LGPL-3.0'
      : has('version 2.1')
        ? 'LGPL-2.1'
        : 'LGPL'
  if (has('gnu general public license'))
    return has('version 3') ? 'GPL-3.0' : has('version 2') ? 'GPL-2.0' : 'GPL'
  if (has('mozilla public license') && has('2.0')) return 'MPL-2.0'
  if (has('apache license') && has('version 2.0')) return 'Apache-2.0'
  if (
    has(
      'this is free and unencumbered software released into the public domain',
    )
  )
    return 'Unlicense'
  if (has('permission is hereby granted, free of charge')) return 'MIT'
  if (has('permission to use, copy, modify, and/or distribute this software'))
    return 'ISC'
  if (has('redistribution and use in source and binary forms')) {
    if (has('neither the name')) return 'BSD-3-Clause'
    return 'BSD-2-Clause'
  }
  if (has('boost software license')) return 'BSL-1.0'
  if (has('business source license')) return 'BUSL-1.1'
  if (has('creative commons') && has('cc0')) return 'CC0-1.0'
  return null
}
