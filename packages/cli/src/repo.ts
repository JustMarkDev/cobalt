import { SxError, exit } from './output'

function git(args: Array<string>): string | undefined {
  try {
    const r = Bun.spawnSync(['git', ...args], { stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * What sx can work out from the folder you are in, so you never have to say
 * it. Each field runs its git command when it is first read: most commands
 * need only the repository, and every git process costs a few milliseconds.
 */
export function gitContext(): {
  readonly slug: string | undefined
  readonly branch: string | undefined
  readonly subject: string | undefined
} {
  const lazy = <T>(make: () => T) => {
    let made: { value: T } | undefined
    return () => (made ??= { value: make() }).value
  }
  const slug = lazy(() =>
    git(['remote', 'get-url', 'origin'])
      ?.match(/source\.code[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
      ?.at(1),
  )
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

/** `-R owner/name`, then `SX_REPO`, then the git remote. Whether it exists is the API's to say. */
export function resolveRepo(flag: string | undefined): RepoRef {
  const slug = flag ?? process.env.SX_REPO ?? gitContext().slug
  if (!slug)
    throw new SxError(
      'repo_unknown',
      'Could not tell which repository you mean.',
      'Run inside a clone, pass -R owner/name, or set SX_REPO.',
      exit.usage,
    )
  const [owner, name, ...extra] = slug.split('/')
  if (!owner || !name || extra.length)
    throw new SxError(
      'repo_unknown',
      `${slug} is not owner/name.`,
      'Pass -R owner/name.',
      exit.usage,
    )
  return { slug, owner, name, path: `/repos/${owner}/${name}` }
}
