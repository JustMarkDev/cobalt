// 11. LFS in App mode: upload an LFS object to Code Storage, push its pointer,
// and see whether GitHub has the object. git-lfs is not installed here, so the
// probe speaks the LFS batch API itself (it is plain HTTP).
import { createHash, randomBytes } from 'node:crypto'
import { GITHUB_OWNER, clean, commitFile, sh } from '../lib'
import type { Scenario } from '../lib'

const LFS = 'application/vnd.git-lfs+json'

type Batch = {
  objects?: Array<{
    oid: string
    size: number
    actions?: Record<string, { href: string; header?: Record<string, string> }>
    error?: { code: number; message: string }
  }>
  message?: string
}

async function batch(
  url: string,
  authorization: string,
  operation: string,
  oid: string,
  size: number,
) {
  const r = await fetch(`${url}/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { accept: LFS, 'content-type': LFS, authorization },
    body: JSON.stringify({
      operation,
      transfers: ['basic'],
      objects: [{ oid, size }],
    }),
  })
  const text = await r.text()
  let body: Batch = {}
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, body, text: text.slice(0, 300) }
}

/** The batch answer without hrefs or headers, which carry signed URLs. */
const shape = (b: Batch) =>
  JSON.stringify(
    (b.objects ?? []).map((o) => ({
      actions: o.actions ? Object.keys(o.actions) : undefined,
      error: o.error,
    })),
  )

export const lfs: Scenario = {
  id: 'github-11-lfs',
  title: 'LFS in App mode',
  async run(ctx) {
    const { name } = await ctx.pair('lfs')
    const data = randomBytes(64 * 1024)
    const oid = createHash('sha256').update(data).digest('hex')
    const size = data.length

    const token = await ctx.remoteToken(name)
    const storeAuth = `Basic ${btoa(`t:${token}`)}`
    const up = await batch(ctx.storeUrl(name), storeAuth, 'upload', oid, size)
    ctx.log.line(
      `Code Storage LFS batch upload: HTTP ${up.status} ${up.body.objects ? shape(up.body) : up.text}`,
    )
    const action = up.body.objects?.[0]?.actions?.upload
    let uploaded = up.status === 200 && !action ? 'already there' : 'no'
    if (action) {
      const put = await fetch(action.href, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          ...action.header,
        },
        body: data,
      })
      uploaded = `HTTP ${put.status}`
      ctx.log.line(
        `upload of the object: HTTP ${put.status} ${put.ok ? '' : (await put.text()).slice(0, 200)}`,
      )
      const verify = up.body.objects?.[0]?.actions?.verify
      if (verify) {
        const v = await fetch(verify.href, {
          method: 'POST',
          headers: { accept: LFS, 'content-type': LFS, ...verify.header },
          body: JSON.stringify({ oid, size }),
        })
        ctx.log.line(`verify: HTTP ${v.status}`)
      }
    }

    const dir = await ctx.cloneStore(name)
    commitFile(
      dir,
      '.gitattributes',
      '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    )
    const sha = commitFile(
      dir,
      'blob.bin',
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`,
    )
    const p = await ctx.gitStore(name, dir, ['push', 'origin', 'HEAD:main'])
    ctx.log.line(`push of the pointer exit ${p.code}: ${clean(p.out)}`)
    const arrived = p.ok
      ? await ctx.ghWaitFor(name, 'main', sha, 60_000)
      : { value: undefined, ms: 0 }
    ctx.log.line(`pointer commit on GitHub: ${Boolean(arrived.value)}`)

    // Does GitHub have the object? Ask its LFS batch API for a download.
    const ghToken = sh(['gh', 'auth', 'token']).out
    const gh = { found: false, answer: '' }
    const t = Date.now()
    while (Date.now() - t < 60_000) {
      const down = await batch(
        `https://github.com/${GITHUB_OWNER}/${name}.git`,
        `Basic ${btoa(`x-access-token:${ghToken}`)}`,
        'download',
        oid,
        size,
      )
      gh.answer = `HTTP ${down.status} ${down.body.objects ? shape(down.body) : down.text}`
      if (down.body.objects?.[0]?.actions?.download) {
        gh.found = true
        break
      }
      await Bun.sleep(5000)
    }
    ctx.log.line(
      `GitHub LFS batch download (${Date.now() - t} ms): ${gh.answer}`,
    )

    const storeHasLfs = up.status === 200
    return {
      outcome: gh.found ? 'pass' : 'finding',
      summary: `Code Storage LFS upload: ${storeHasLfs ? `batch ok, upload ${uploaded}` : `HTTP ${up.status}`}. Pointer push ${p.ok ? 'ok' : 'refused'}. GitHub ${gh.found ? 'has' : 'does not have'} the object (${gh.answer}).`,
      consequence: gh.found
        ? 'LFS objects pushed through Code Storage reach GitHub in App mode; set the LFS flag on GitHub imports.'
        : 'LFS objects pushed through Code Storage do not reach GitHub: warn on LFS repositories even for GitHub, and keep LFS out of v1.',
    }
  },
}
