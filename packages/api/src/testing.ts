import { getFakeGitRepo } from '@cobaltforge/git/fake'
import { StoreGit } from './git'
import { T0, sampleTokens } from './sample'
import { createSampleApi } from './index'
import type { GitData } from './git'

export function clock(start = T0 + 3_600_000) {
  let t = start
  const now = () => t
  return Object.assign(now, {
    advance(ms: number) {
      t += ms
    },
  })
}

export type Reply = {
  status: number
  headers: Headers
  json: any
  text: string
  res: Response
}

export const onConvex = process.env.CB_DOMAIN === 'convex'

export function harness(overrides: Parameters<typeof createSampleApi>[0] = {}) {
  const now = overrides.now ?? clock()
  const api = createSampleApi({
    mount: '/v1',
    now,
    ephemeralSecrets: true,
    ...(onConvex
      ? { domainFactory: require('./convex-testing').convexFactory }
      : {}),
    ...overrides,
  })
  const call = async (
    method: string,
    path: string,
    init: {
      token?: string | null
      body?: unknown
      headers?: Record<string, string>
      raw?: string
    } = {},
  ): Promise<Reply> => {
    const token = init.token === undefined ? sampleTokens.dana : init.token
    const headers: Record<string, string> = { ...init.headers }
    if (token) headers.authorization = `Bearer ${token}`
    let body: string | undefined
    if (init.raw !== undefined) body = init.raw
    else if (init.body !== undefined) body = JSON.stringify(init.body)
    if (body !== undefined && !('content-type' in headers))
      headers['content-type'] = 'application/json'
    const res = await api.fetch(
      new Request(`https://api.test/v1${path}`, { method, headers, body }),
    )
    const text = await res.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: res.status, headers: res.headers, json, text, res }
  }
  return { api, call, now, tokens: sampleTokens }
}

export function gitWith(files: Record<string, string>): GitData {
  const base = new StoreGit(getFakeGitRepo)
  return {
    files: (repo, ref) => base.files(repo, ref),
    blob: async (repo, path, ref) =>
      path in files
        ? new TextEncoder().encode(files[path])
        : base.blob(repo, path, ref),
    commits: (repo, limit, from) => base.commits(repo, limit, from),
    blame: (repo, path, ref) => base.blame(repo, path, ref),
    compare: (repo, b, head, path) => base.compare(repo, b, head, path),
    commit: (repo, sha) => base.commit(repo, sha),
    diff: (repo, sha, b) => base.diff(repo, sha, b),
    setRepo: (repo, id) => base.setRepo(repo, id),
    dropRepo: (repo) => base.dropRepo(repo),
    storeOf: (repo) => base.storeOf(repo),
  }
}

export async function asPerson(
  h: ReturnType<typeof harness>,
  handle: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const { personPrincipal } = await import('./auth')
  const res = await h.api.fetchAs(
    personPrincipal(handle, h.now()),
    new Request(`https://api.test/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

export async function withRunsOn(
  labels: Array<string> | string,
  now = clock(),
) {
  const probe = harness({ now })
  const last = (
    await probe.call(
      'GET',
      `/repos/dana/gitfs/pipelines?workflow=build&limit=1`,
    )
  ).json.data[0]
  const run = (
    await probe.call('GET', `/repos/dana/gitfs/pipelines/${last.number}`)
  ).json
  const yaml = [
    'jobs:',
    ...run.jobs.flatMap((j: any) => [
      `  ${JSON.stringify(j.name)}:`,
      `    runs-on: ${JSON.stringify(labels)}`,
    ]),
  ].join('\n')
  return harness({ now, git: gitWith({ [run.file]: yaml }) })
}
