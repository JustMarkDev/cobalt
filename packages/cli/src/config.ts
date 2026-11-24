import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CbError, exit } from './output'

export const defaults = {
  host: 'https://cobaltforge.dev',
  api: '',
  account: '',
  output: 'auto',
  'handoff.to': 't3',
  'change.base': 'main',
  'change.draft': 'false',
} as const

export type Key = keyof typeof defaults
export const keys = Object.keys(defaults) as Array<Key>

export function isKey(k: string): k is Key {
  return (keys as Array<string>).includes(k)
}

export function configPath(): string {
  const dir =
    process.env.CB_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cb')
  return join(dir, 'config.json')
}

export function readConfig(): Partial<Record<Key, string>> {
  const p = configPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Partial<Record<Key, string>>
  } catch {
    throw new CbError(
      'config_invalid',
      `${p} is not valid JSON.`,
      `Fix the file or delete it. cb config path prints its location.`,
      exit.error,
    )
  }
}

export function writeConfig(next: Partial<Record<Key, string>>) {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n')
}

export function resolve(key: Key): { value: string; from: string } {
  const env = process.env[`CB_${key.toUpperCase().replace('.', '_')}`]
  if (env) return { value: env, from: 'env' }
  const file = readConfig()[key]
  if (file !== undefined) return { value: file, from: 'file' }
  return { value: defaults[key], from: 'default' }
}
