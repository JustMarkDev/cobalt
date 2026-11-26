// Compare a repository imported from GitHub with GitHub itself, read only, and
// print every difference. Exits 1 when something does not match.
//
//   bun scripts/dev/check-import.ts mark/music-companion
//   bun scripts/dev/check-import.ts mark/music-companion --github JustMarkDev/music-companion
//
// Needs the local app on CB_API (default http://localhost:3000/api/v1), `gh`
// signed in, and a token: CB_TOKEN, or minted with scripts/dev/token.ts.
import { $ } from 'bun'

const full = process.argv.at(2)
if (!full?.includes('/')) {
  console.error(
    'usage: bun scripts/dev/check-import.ts <owner/repo> [--github <owner/repo>] [--json]',
  )
  process.exit(2)
}
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const API = process.env.CB_API ?? 'http://localhost:3000/api/v1'
const token =
  process.env.CB_TOKEN ??
  (
    await $`bun ${import.meta.dir}/token.ts ${full.split('/')[0]} --ttl 3600`.text()
  ).trim()

type Json = any

async function cb(path: string): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  if (!res.ok)
    throw new Error(`cobalt ${path}: ${res.status} ${body.detail ?? ''}`)
  return body
}

async function cbAll(path: string): Promise<Array<Json>> {
  const out: Array<Json> = []
  let next: string | null = null
  for (let i = 0; i < 50; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await cb(
      `${path}${sep}limit=100${next ? `&cursor=${next}` : ''}`,
    )
    out.push(...page.data)
    if (!page.has_more || !page.next_cursor) break
    next = page.next_cursor
  }
  return out
}

async function gh(path: string): Promise<Json> {
  return JSON.parse(await $`gh api ${path}`.quiet().text())
}

async function ghAll(path: string): Promise<Array<Json>> {
  const text = await $`gh api --paginate ${path}`.quiet().text()
  // --paginate concatenates JSON arrays: `[...][...]`.
  return JSON.parse(`[${text.replace(/\]\s*\[/g, '],[')}]`).flat()
}

const repo = await cb(`/repos/${full}`)
const slug = flag('github') ?? repo.upstream?.slug
if (!slug) {
  console.error(`${full} has no GitHub upstream; pass --github owner/repo.`)
  process.exit(2)
}

type Finding = { area: string; what: string; github: unknown; cobalt: unknown }
const findings: Array<Finding> = []
const checked: Record<string, number> = {}
const same = (area: string, what: string, github: unknown, cobalt: unknown) => {
  checked[area] = (checked[area] ?? 0) + 1
  if (JSON.stringify(github) !== JSON.stringify(cobalt))
    findings.push({ area, what, github, cobalt })
}

// About
const g = await gh(`repos/${slug}`)
same('about', 'description', g.description ?? '', repo.description ?? '')
same('about', 'website', g.homepage || null, repo.website ?? null)
same('about', 'default branch', g.default_branch, repo.default_branch)
same('about', 'license', g.license?.spdx_id ?? null, repo.license ?? null)
same(
  'about',
  'visibility',
  g.private ? 'private' : 'public',
  repo.visibility === 'private' ? 'private' : 'public',
)
same(
  'about',
  'open issues',
  (await ghAll(`repos/${slug}/issues?state=open&per_page=100`)).filter(
    (i) => !i.pull_request,
  ).length,
  repo.open_issues,
)
same(
  'about',
  'open changes',
  (await ghAll(`repos/${slug}/pulls?state=open&per_page=100`)).length,
  repo.open_changes,
)

// Pull requests → changes
const pulls = await ghAll(`repos/${slug}/pulls?state=all&per_page=100`)
const changes = new Map(
  (await cbAll(`/repos/${full}/changes?state=all`)).map((c) => [c.number, c]),
)
for (const p of pulls) {
  const c = changes.get(p.number)
  const at = `#${p.number}`
  if (!c) {
    findings.push({
      area: 'changes',
      what: `${at} missing`,
      github: p.title,
      cobalt: null,
    })
    continue
  }
  same('changes', `${at} title`, p.title, c.title)
  same(
    'changes',
    `${at} state`,
    p.merged_at
      ? 'landed'
      : p.state === 'open'
        ? p.draft
          ? 'draft'
          : 'open'
        : 'abandoned',
    c.state,
  )
  same(
    'changes',
    `${at} branch`,
    `${p.base.ref} ← ${p.head.ref}`,
    `${c.base} ← ${c.branch}`,
  )
  if (p.state !== 'open') continue
  // Open ones: the diff must be readable, and "landable" must agree with GitHub.
  const sets = await cb(`/repos/${full}/changes/${p.number}/patch-sets`)
  const last = sets.data.at(-1)
  same('changes', `${at} head commit`, p.head.sha, last?.sha)
  const files = await cb(
    `/repos/${full}/changes/${p.number}/patch-sets/${last.number}/files`,
  )
  const ghFiles = (
    await ghAll(`repos/${slug}/pulls/${p.number}/files?per_page=100`)
  )
    .map((f) => String(f.filename))
    .sort((a, b) => a.localeCompare(b))
  same(
    'changes',
    `${at} files`,
    ghFiles,
    files.files
      .map((f: Json) => String(f.path))
      .sort((a: string, b: string) => a.localeCompare(b)),
  )
  const full_ = await gh(`repos/${slug}/pulls/${p.number}`)
  const runs = (
    await gh(`repos/${slug}/commits/${p.head.sha}/check-runs?per_page=100`)
  ).check_runs as Array<Json>
  const failing = runs.some((r) =>
    ['failure', 'timed_out', 'cancelled', 'action_required'].includes(
      r.conclusion,
    ),
  )
  const running = runs.some((r) => r.status !== 'completed')
  const ghLandable =
    full_.mergeable !== false && !failing && !running && !p.draft
  const land = await cb(`/repos/${full}/changes/${p.number}/landability`)
  same(
    'changes',
    `${at} landable (GitHub: mergeable ${full_.mergeable}, checks ${failing ? 'failing' : running ? 'running' : 'green'})`,
    ghLandable,
    land.landable,
  )
}

// Issues
const issues = (
  await ghAll(`repos/${slug}/issues?state=all&per_page=100`)
).filter((i) => !i.pull_request)
const ours = new Map(
  (await cbAll(`/repos/${full}/issues?state=all`)).map((i) => [i.number, i]),
)
for (const i of issues) {
  const o = ours.get(i.number)
  const at = `#${i.number}`
  if (!o) {
    findings.push({
      area: 'issues',
      what: `${at} missing`,
      github: i.title,
      cobalt: null,
    })
    continue
  }
  same('issues', `${at} title`, i.title, o.title)
  same('issues', `${at} state`, i.state, o.state)
  same('issues', `${at} comments`, i.comments, o.comments)
  same(
    'issues',
    `${at} labels`,
    i.labels.map((l: Json) => l.name).sort(),
    o.labels.map((l: Json) => (typeof l === 'string' ? l : l.name)).sort(),
  )
  if (i.state === 'closed')
    same(
      'issues',
      `${at} closed as`,
      i.state_reason === 'not_planned' ? 'not_planned' : 'completed',
      o.closed_as,
    )
}

// Releases
const rels = await ghAll(`repos/${slug}/releases?per_page=100`)
const ourRels = new Map(
  (await cbAll(`/repos/${full}/releases`)).map((r) => [r.tag, r]),
)
for (const r of rels) {
  const o = ourRels.get(r.tag_name)
  if (r.draft) continue
  if (!o) {
    findings.push({
      area: 'releases',
      what: `${r.tag_name} missing`,
      github: r.name,
      cobalt: null,
    })
    continue
  }
  same('releases', `${r.tag_name} title`, r.name || r.tag_name, o.title)
  same(
    'releases',
    `${r.tag_name} channel`,
    r.prerelease ? 'prerelease' : 'stable',
    o.channel === 'stable' ? 'stable' : 'prerelease',
  )
}

// Git: the default branch and its history
const head = await gh(`repos/${slug}/commits/${g.default_branch}`)
const ourHead = (await cb(`/repos/${full}/git/commits?limit=1`)).data?.[0]
same('git', 'default branch head', head.sha, ourHead?.sha)

// Contributors: people only, each once
const contributors = (await cb(`/repos/${full}/contributors`))
  .data as Array<Json>
same(
  'contributors',
  'no bots',
  [],
  contributors.filter((c) => /bot\b|\[bot\]/i.test(c.name)).map((c) => c.name),
)
const names = contributors.map((c) => c.handle ?? c.email.toLowerCase())
same('contributors', 'each person once', [...new Set(names)], names)

const summary = Object.entries(checked)
  .map(([k, n]) => `${k} ${n}`)
  .join(', ')
if (process.argv.includes('--json'))
  console.log(
    JSON.stringify({ repo: full, github: slug, checked, findings }, null, 2),
  )
else {
  console.log(`${full} ↔ github.com/${slug}: checked ${summary}`)
  for (const f of findings)
    console.log(
      `✗ [${f.area}] ${f.what}\n    github: ${JSON.stringify(f.github)}\n    cobalt: ${JSON.stringify(f.cobalt)}`,
    )
  console.log(
    findings.length ? `${findings.length} differences` : '✓ everything matches',
  )
}
process.exit(findings.length ? 1 : 0)
