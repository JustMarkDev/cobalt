import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { copyHistory } from './transfer'

// Two bare repositories behind `git http-backend`, the smart-HTTP server git
// ships with: the copy must leave the target a real, complete repository.
const dir = mkdtempSync(join(tmpdir(), 'cb-transfer-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function serveGit(root: string) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const p = Bun.spawn(['git', 'http-backend'], {
        env: {
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get('content-type') ?? '',
          REMOTE_USER: 'cobalt',
          PATH: process.env.PATH ?? '',
        },
        stdin: req.body ? new Uint8Array(await req.arrayBuffer()) : 'ignore',
        stdout: 'pipe',
      })
      const out = Buffer.from(await new Response(p.stdout).arrayBuffer())
      const sep = out.indexOf('\r\n\r\n')
      const headers = new Headers()
      let status = 200
      for (const l of out.subarray(0, sep).toString().split('\r\n')) {
        const i = l.indexOf(':')
        const k = l.slice(0, i).toLowerCase()
        const v = l.slice(i + 1).trim()
        if (k === 'status') status = parseInt(v)
        else headers.set(k, v)
      }
      return new Response(out.subarray(sep + 4), { status, headers })
    },
  })
}

test('every branch and tag reaches an empty repository, the default first', async () => {
  const commit = (m: string) =>
    $`git -c user.name=t -c user.email=t@example.com commit -qam ${m}`
  await $`git init -q --bare ${dir}/a.git && git init -q --bare ${dir}/b.git`
  await $`git -C ${dir}/b.git config http.receivepack true`
  await $`git init -q -b main ${dir}/work`
  $.cwd(`${dir}/work`)
  await $`echo one > f && git add f`
  await commit('one')
  await $`git tag v1 && git checkout -qb aaa-first-by-name`
  await $`echo two >> f`
  await commit('two')
  await $`git push -q ${dir}/a.git main aaa-first-by-name --tags`
  $.cwd(process.cwd())

  const server = serveGit(dir)
  const base = `http://localhost:${server.port}`
  try {
    const copied = await copyHistory(
      { url: `${base}/a.git`, authorization: 'Basic x' },
      { url: `${base}/b.git`, authorization: 'Basic x' },
      { first: 'refs/heads/main' },
    )
    expect([...copied.keys()]).toEqual([
      'refs/heads/main',
      'refs/heads/aaa-first-by-name',
      'refs/tags/v1',
    ])
    const refs = async (repo: string) =>
      (
        await $`git -C ${repo} for-each-ref --format=${'%(refname) %(objectname)'}`.text()
      ).trim()
    expect(await refs(`${dir}/b.git`)).toBe(await refs(`${dir}/a.git`))
    await $`git -C ${dir}/b.git fsck --no-progress`.quiet()
  } finally {
    void server.stop(true)
  }
})
