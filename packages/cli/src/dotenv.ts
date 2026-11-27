// .env files: which environment each one is for, and what is in it.

export type Environment = 'development' | 'preview' | 'production'

/** Files that hold values, as opposed to the schema or an example. */
export function isValuesFile(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  return (
    /^\.env(\..+)?$/.test(name) &&
    !/^\.env\.(schema|example|sample|template|defaults)$/.test(name)
  )
}

/** `.env.production.local` is production; `.env` and `.env.local` development. */
export function environmentOf(path: string): Environment {
  const name = path.split('/').at(-1) ?? ''
  const parts = name
    .split('.')
    .slice(2)
    .filter((p) => p !== 'local')
  const e = parts[0]?.toLowerCase()
  if (e && /^(prod|production|live)$/.test(e)) return 'production'
  if (e && /^(preview|staging|stage|test|qa)$/.test(e)) return 'preview'
  return 'development'
}

/**
 * The variables of a .env file: `KEY=value`, `export KEY=value`, single,
 * double and multi-line double quotes, `#` comments. Empty values are left
 * out (there is nothing to keep).
 */
export function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/.exec(
      lines[i],
    )
    if (!m) continue
    let value = m[2]
    if (value.startsWith('"')) {
      let body = value.slice(1)
      while (!/(^|[^\\])"\s*(#.*)?$/.test(body) && i + 1 < lines.length)
        body += `\n${lines[++i]}`
      value = body
        .replace(/"\s*(#.*)?$/, '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
    } else if (value.startsWith("'"))
      value = value.slice(1).replace(/'\s*(#.*)?$/, '')
    else value = value.replace(/\s+#.*$/, '').trim()
    if (value !== '') out.push([m[1], value])
  }
  return out
}

/** Names the schema already has. */
export function schemaNames(schema: string): Set<string> {
  return new Set(
    [
      ...schema.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm),
    ].map((m) => m[1]),
  )
}

/** The schema with these names added, as secrets, values left out. */
export function withNames(schema: string, names: ReadonlyArray<string>) {
  const have = schemaNames(schema)
  const add = names.filter((n) => !have.has(n))
  if (!add.length) return { schema, added: [] as Array<string> }
  const head = schema.trim()
    ? schema.replace(/\n*$/, '\n\n')
    : '# @defaultSensitive=true @defaultRequired=infer\n# ---\n'
  return {
    schema: `${head}${add.map((n) => `# @sensitive\n${n}=\n`).join('\n')}`,
    added: add,
  }
}
