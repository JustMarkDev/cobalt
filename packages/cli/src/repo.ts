import { CbError, exit } from './output'
import { resolve } from './config'

function git(args: Array<string>): string | undefined {
  try {
    const r = Bun.spawnSync(['git', ...args], { stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

export function gitContext(): {
  readonly slug: string | undefined
  readonly branch: string | undefined
  readonly subject: string | undefined
} {
  const lazy = <T>(make: () => T) => {
    let made: { value: T } | undefined
    return () => (made ??= { value: make() }).value
  }
  const slug = lazy(() => {
    const url = git(['remote', 'get-url', 'origin'])
    return url ? slugOfRemote(url, serverHosts()) : undefined
  })
  const branch = lazy(() => git(['rev-parse', '--abbrev-ref', 'HEAD']))
  const subject = lazy(() => git(['log', '-1', '--format=%s']))
  return {
    get slug() {
      return slug()
    },
    get branch() {
      return branch()
    },
    get subject() {
      return subject()
    },
  }
}

export type RepoRef = {
  slug: string
  owner: string
  name: string
  path: string
}

export function resolveRepo(flag: string | undefined): RepoRef {
  const slug = flag ?? process.env.CB_REPO ?? gitContext().slug
  if (!slug)
    throw new CbError(
      'repo_unknown',
      'Could not tell which repository you mean.',
      'Run inside a clone, pass -R owner/name, or set CB_REPO.',
      exit.usage,
    )
  const [owner, name, ...extra] = slug.split('/')
  if (!owner || !name || extra.length)
    throw new CbError(
      'repo_unknown',
      `${slug} is not owner/name.`,
      'Pass -R owner/name.',
      exit.usage,
    )
  return { slug, owner, name, path: `/repos/${owner}/${name}` }
}

/** Hosts whose remotes are this cobalt: the public one and the one cb talks to. */
function serverHosts(): Array<string> {
  const out = new Set(['cobaltforge.dev'])
  for (const v of [resolve('api').value, resolve('host').value])
    try {
      if (v) out.add(new URL(v).host)
    } catch {
      // Not a URL: nothing to add.
    }
  return [...out]
}

/** `owner/name` from a remote on one of `hosts`, over HTTPS or SSH. */
export function slugOfRemote(
  url: string,
  hosts: ReadonlyArray<string>,
): string | undefined {
  for (const h of hosts) {
    const at = url.replace(/^\w+:\/\/(?:[^@/]*@)?/, '').replace(/^[^@/]*@/, '')
    if (!at.toLowerCase().startsWith(h.toLowerCase())) continue
    const m = /^[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(at.slice(h.length))
    if (m) return m[1]
  }
  return undefined
}
