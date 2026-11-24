import * as React from 'react'
import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import type { RepoPage } from '~/components/forge/repo-shell'
import { RequireAuth } from '~/components/forge/auth'
import { RepoFrame } from '~/components/forge/repo-shell'
import type { Repo } from '~/lib/model/data'
import { ForgeRefused, loadOp, useOp } from '~/lib/forge'
import { toRelease, toRepo } from '~/lib/repo'

const activeOf: Partial<Record<string, RepoPage>> = {
  code: 'code',
  issues: 'issues',
  changes: 'pulls',
  pipelines: 'pipelines',
  releases: 'release',
  insights: 'insights',
  settings: 'settings',
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined
  return () => {
    if (!loading) {
      const p: Promise<T> = load().then((value) => {
        const tracked = p as Promise<T> & { status?: string; value?: T }
        tracked.status = 'fulfilled'
        tracked.value = value
        return value
      })
      void p.catch(() => {
        if (loading === p) loading = undefined
      })
      loading = p
    }
    return loading
  }
}

const modules = {
  variants: once(() => import('~/components/forge/repo-variants')),
  releases: once(() => import('~/components/forge/repo-releases')),
  pages: once(() => import('~/components/forge/repo-pages')),
  changes: once(() => import('~/components/forge/repo-changes')),
  runs: once(() => import('~/components/forge/repo-runs')),
  settings: once(() => import('~/components/forge/repo-settings')),
}
const moduleOf: Partial<Record<string, keyof typeof modules>> = {
  code: 'variants',
  releases: 'releases',
  issues: 'pages',
  insights: 'pages',
  changes: 'changes',
  pipelines: 'runs',
  settings: 'settings',
}

function loadTab(tab: string) {
  const name = moduleOf[tab]
  return name ? modules[name]() : null
}

type TabSearch = {
  n?: number
  section?: string
  confirm?: string
  path?: string
  view?: 'history'
}

export const Route = createFileRoute('/$handle/$repo/$tab')({
  beforeLoad: ({ params }) => {
    if (params.tab === 'actions')
      throw redirect({
        to: '/$handle/$repo/$tab',
        params: { ...params, tab: 'pipelines' },
        search: true,
      })
  },
  head: ({ params }) => ({
    meta: [{ title: `${params.handle}/${params.repo} · cobalt` }],
  }),
  validateSearch: (s: Record<string, unknown>): TabSearch => ({
    n:
      typeof s.n === 'number'
        ? s.n
        : typeof s.n === 'string' && s.n
          ? Number(s.n)
          : undefined,
    section: typeof s.section === 'string' ? s.section : undefined,
    confirm:
      typeof s.confirm === 'string' && /^cnf_[0-9a-z]+$/.test(s.confirm)
        ? s.confirm
        : undefined,
    path: typeof s.path === 'string' && s.path ? s.path : undefined,
    view: s.view === 'history' ? 'history' : undefined,
  }),
  loader: ({ context, params }) =>
    Promise.all([
      loadOp(context.queryClient, 'repos.get', {
        owner: params.handle,
        repo: params.repo,
      }),
      loadOp(context.queryClient, 'releases.list', {
        owner: params.handle,
        repo: params.repo,
        limit: 50,
      }),
      loadTab(params.tab),
    ])
      .then(([repo, releases]) => [repo, releases] as const)
      .catch((e: unknown) => {
        const to =
          e instanceof ForgeRefused && e.code === 'moved' ? e.moved_to : null
        if (!to) throw e
        const [handle, repo] = to.split('/')
        throw redirect({
          to: '/$handle/$repo/$tab',
          params: { handle, repo, tab: params.tab },
          statusCode: 308,
        })
      }),
  component: RepoTab,
})

function RepoTab() {
  const { handle, repo: name, tab } = Route.useParams()
  const { n, section, path, view } = Route.useSearch()
  const found = useOp('repos.get', { owner: handle, repo: name })
  const releases = useOp('releases.list', {
    owner: handle,
    repo: name,
    limit: 50,
  }).data
  const repo = React.useMemo(
    () => toRepo(found, releases.map(toRelease)),
    [found, releases],
  )
  const [finding, setFinding] = React.useState(false)
  const active = activeOf[tab]
  if (!active) throw notFound()

  const shown = React.useDeferredValue(
    React.useMemo(
      () => ({ tab, n, section, path, view }),
      [tab, n, section, path, view],
    ),
  )

  return (
    <RepoFrame
      key={repo.name}
      repo={repo}
      active={active}
      counts={{
        issues: found.open_issues,
        pulls: found.open_changes,
      }}
      actions={
        shown.tab === 'code' && shown.view !== 'history' ? (
          <CodeActions repo={repo} onFind={() => setFinding(true)} />
        ) : undefined
      }
    >
      <RepoTabPage
        tab={shown.tab}
        repo={repo}
        n={shown.n}
        section={shown.section}
        path={shown.path}
        view={shown.view}
        finding={finding}
        onFinding={setFinding}
      />
    </RepoFrame>
  )
}

function RepoTabPage({
  tab,
  repo,
  n,
  section,
  path,
  view,
  finding,
  onFinding,
}: {
  tab: string
  repo: Repo
  n?: number
  section?: string
  path?: string
  view?: 'history'
  finding: boolean
  onFinding: (open: boolean) => void
}) {
  switch (tab) {
    case 'code': {
      const { CodePage } = React.use(modules.variants())
      return (
        <CodePage
          repo={repo}
          path={path}
          view={view}
          finding={finding}
          onFinding={onFinding}
        />
      )
    }
    case 'issues': {
      const { IssuesPage } = React.use(modules.pages())
      return <IssuesPage key={repo.name} repo={repo} n={n} />
    }
    case 'changes': {
      const { ChangesPage } = React.use(modules.changes())
      return <ChangesPage key={repo.name} repo={repo} n={n} />
    }
    case 'pipelines': {
      const { PipelinesPage } = React.use(modules.runs())
      return <PipelinesPage key={repo.name} repo={repo} n={n} />
    }
    case 'releases': {
      const { ReleasesPage } = React.use(modules.releases())
      return <ReleasesPage repo={repo} />
    }
    case 'insights': {
      const { InsightsPage } = React.use(modules.pages())
      return <InsightsPage repo={repo} />
    }
    case 'settings': {
      const { RepoSettings } = React.use(modules.settings())
      return (
        <RequireAuth>
          <RepoSettings repo={repo} section={section} />
        </RequireAuth>
      )
    }
    default:
      throw notFound()
  }
}

function CodeActions(
  props: React.ComponentProps<
    Awaited<ReturnType<typeof modules.variants>>['CodeActions']
  >,
) {
  const { CodeActions: Actions } = React.use(modules.variants())
  return <Actions {...props} />
}
