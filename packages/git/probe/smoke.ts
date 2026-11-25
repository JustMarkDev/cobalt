import { Pierre } from '@pierre/sdk'

const PREFIX = 'cobalt-probe-'

const sh = (args: Array<string>) => {
  const p = Bun.spawnSync(args)
  return {
    ok: p.exitCode === 0,
    out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
  }
}

const org = process.env.PIERRE_ORG
const privateKey = process.env.PIERRE_PRIVATE_KEY
if (!org || !privateKey) {
  console.error(
    'PIERRE_ORG and PIERRE_PRIVATE_KEY are not set: run it with `railway run --`.',
  )
  process.exit(2)
}
const me = sh(['gh', 'api', 'user', '--jq', '.login'])
if (!me.ok) {
  console.error(`gh is not signed in: ${me.out}`)
  process.exit(2)
}
const owner = me.out
const name = `${PREFIX}smoke-${Date.now().toString(36)}`
const pierre = new Pierre({ org, privateKey })

const errorOf = (e: unknown) => {
  const x = e as { status?: number; code?: string; message?: string }
  return `${x.status ?? '?'} ${x.code ?? ''} ${x.message ?? String(e)}`.trim()
}

let madeOnGithub = false
let madeOnStorage = false
let ok = false
try {
  const made = sh([
    'gh',
    'repo',
    'create',
    `${owner}/${name}`,
    '--private',
    '--add-readme',
  ])
  console.log(
    `1. GitHub repository ${owner}/${name}: ${made.ok ? 'created' : `FAILED: ${made.out}`}`,
  )
  if (!made.ok) throw new Error('could not create the GitHub repository')
  madeOnGithub = true

  const t0 = Date.now()
  try {
    await pierre.repos.create({
      repo_name: name,
      default_branch: 'main',
      upstream: { provider: 'github', owner, name },
    })
    madeOnStorage = true
    console.log(
      `2. Code Storage repos.create with a GitHub upstream: accepted in ${Date.now() - t0} ms`,
    )
  } catch (e) {
    console.log(
      `2. Code Storage repos.create with a GitHub upstream: REFUSED: ${errorOf(e)}`,
    )
    throw e
  }

  const deadline = Date.now() + 120_000
  let seen: string | null = null
  let last = ''
  while (Date.now() < deadline) {
    try {
      const page = await pierre.repos.branches.list({ repo_name: name })
      const branches =
        (page as any).body?.branches ?? (page as any).branches ?? []
      if (branches.length) {
        seen = branches
          .map((b: any) => b.name ?? b.branch ?? JSON.stringify(b))
          .join(', ')
        break
      }
      last = 'no branches yet'
    } catch (e) {
      last = errorOf(e)
    }
    await Bun.sleep(2000)
  }
  console.log(
    seen
      ? `3. First sync: branches (${seen}) after ${Date.now() - t0} ms`
      : `3. First sync: nothing after 120 s (last answer: ${last})`,
  )
  ok = Boolean(seen)
} catch (e) {
  console.log(`stopped: ${errorOf(e)}`)
} finally {
  if (madeOnStorage && name.startsWith(PREFIX)) {
    try {
      await pierre.repos.delete({ repo_name: name })
      console.log('cleanup: Code Storage repository deleted')
    } catch (e) {
      console.log(`cleanup: Code Storage repository NOT deleted: ${errorOf(e)}`)
    }
  }
  if (madeOnGithub && name.startsWith(PREFIX)) {
    const d = sh(['gh', 'repo', 'delete', `${owner}/${name}`, '--yes'])
    console.log(
      `cleanup: GitHub repository ${d.ok ? 'deleted' : `NOT deleted: ${d.out}`}`,
    )
  }
}
console.log(
  ok
    ? 'RESULT: the App syncs through Code Storage.'
    : 'RESULT: not working, see above.',
)
process.exit(ok ? 0 : 1)
