import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  BookOpenIcon,
  FileTextIcon,
  GlobeIcon,
  HeartIcon,
  RocketLaunchIcon,
  ScalesIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import { Avatar } from './bits'
import { CopyField, Languages } from './repo-shell'
import type { Repo } from '~/lib/model/data'
import { Segmented } from '~/components/ui/tabs'
import { latestStable } from '~/lib/model/data'
import { useOpMaybe } from '~/lib/forge'
import { installsFor } from '~/lib/install-commands'
import type { Install } from '~/lib/install-commands'

const SHOWN_AVATARS = 6
const MONTH = 30 * 24 * 3_600_000

const handleOf = (c: { name: string; email: string }) =>
  c.email.toLowerCase().endsWith('@users.cobaltforge.dev')
    ? c.email.split('@')[0]
    : c.name

/** Install commands from the owners, or else from the README. Empty when neither has any. */
export function useInstalls(repo: Repo): Array<Install> {
  const file = useOpMaybe('git.blob', {
    owner: repo.owner,
    repo: repo.name,
    path: 'README.md',
  })
  const readme = file?.encoding === 'utf-8' ? file.content : ''
  return React.useMemo(
    () => installsFor(repo.install, readme),
    [repo.install, readme],
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {aside && (
          <span className="text-xs text-muted-foreground">{aside}</span>
        )}
      </div>
      {children}
    </section>
  )
}

type Icon = React.ComponentType<{ className?: string }>

const linkClass =
  'inline-flex items-center gap-1.5 py-0.5 text-muted-foreground hover:text-foreground'

function ExternalLink({
  href,
  icon: Icon,
  children,
}: {
  href: string
  icon: Icon
  children: React.ReactNode
}) {
  return (
    <li>
      <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
        <Icon className="size-4" />
        {children}
      </a>
    </li>
  )
}

/** Where GitHub and others look for a project's community files. */
const COMMUNITY_DIRS = ['', '.github', 'docs'] as const

/**
 * The community files the repository really has, by what they are: a link
 * shows only for a file that exists (any case, at the root, in .github or
 * in docs), never for one that does not.
 */
function useCommunityFiles(repo: Repo) {
  const at = { owner: repo.owner, repo: repo.name }
  const root = useOpMaybe('git.tree', { ...at })?.entries ?? []
  const hidden =
    useOpMaybe('git.tree', { ...at, path: '.github' })?.entries ?? []
  const docs = useOpMaybe('git.tree', { ...at, path: 'docs' })?.entries ?? []
  const all = [root, hidden, docs].flat().filter((e) => e.type === 'blob')
  const find = (re: RegExp) => {
    for (const dir of COMMUNITY_DIRS)
      for (const e of all)
        if (re.test(e.name) && e.path === (dir ? `${dir}/${e.name}` : e.name))
          return e.path
    return null
  }
  return {
    security: find(/^security(\.(md|markdown|txt|rst))?$/i),
    changelog: find(/^(changelog|changes|history)(\.(md|markdown|txt|rst))?$/i),
    contributing: find(/^contributing(\.(md|markdown|txt|rst))?$/i),
    conduct: find(/^code[_-]of[_-]conduct(\.(md|markdown|txt|rst))?$/i),
  }
}

function FileLink({
  repo,
  path,
  icon: Icon,
  children,
}: {
  repo: Repo
  path: string
  icon: Icon
  children: React.ReactNode
}) {
  return (
    <li>
      <Link
        to="/$handle/$repo/$tab"
        params={{ handle: repo.owner, repo: repo.name, tab: 'code' }}
        search={{ path }}
        className={linkClass}
      >
        <Icon className="size-4" />
        {children}
      </Link>
    </li>
  )
}

export function AboutPanel({
  repo,
  onOpenLicense,
}: {
  repo: Repo
  onOpenLicense: () => void
}) {
  const installs = useInstalls(repo)
  const [which, setWhich] = React.useState<string | null>(null)
  const current = installs.find((i) => i.label === which) ?? installs.at(0)
  const release = latestStable(repo)
  const contributors =
    useOpMaybe('repos.contributors', { owner: repo.owner, repo: repo.name })
      ?.data ?? []
  const newest = Math.max(
    0,
    ...contributors.map((c) => Date.parse(c.last_commit_at)),
  )
  const community = useCommunityFiles(repo)
  const active = contributors.filter(
    (c) => newest - Date.parse(c.last_commit_at) < MONTH,
  ).length
  const insights = {
    to: '/$handle/$repo/$tab',
    params: { handle: repo.owner, repo: repo.name, tab: 'insights' },
  } as const
  return (
    <aside className="surface flex min-w-0 flex-col divide-y overflow-hidden rounded-2xl border bg-card text-sm">
      {current && (
        <Section title="Install">
          {installs.length > 1 && (
            <Segmented
              label="Install with"
              className="w-full [&>*>*]:min-w-0 [&>*>*]:flex-1 [&>*>*]:px-1.5"
              value={current.label}
              onChange={setWhich}
              options={installs.map((i): [string, string] => [
                i.label,
                i.label,
              ])}
            />
          )}
          <CopyField value={current.command} prefix="$" />
        </Section>
      )}

      <Section title="Details">
        <ul className="space-y-2">
          {release && (
            <li className="flex items-center gap-2.5">
              <RocketLaunchIcon className="size-4 shrink-0 text-muted-foreground" />
              <Link
                to="/$handle/$repo/$tab"
                params={{
                  handle: repo.owner,
                  repo: repo.name,
                  tab: 'releases',
                }}
                className="font-medium hover:underline"
              >
                {release.version}
              </Link>
              <span className="ml-auto text-xs text-muted-foreground">
                {release.date}
              </span>
            </li>
          )}
          {repo.license && (
            <li className="flex items-center gap-2.5">
              <ScalesIcon className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={onOpenLicense}
                className="font-medium hover:underline"
              >
                {repo.license}
              </button>
              <span className="ml-auto text-xs text-muted-foreground">
                license
              </span>
            </li>
          )}
        </ul>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2.5 text-xs">
          {repo.website && (
            <ExternalLink href={repo.website} icon={GlobeIcon}>
              Website
            </ExternalLink>
          )}
          {repo.docs && (
            <ExternalLink href={repo.docs} icon={BookOpenIcon}>
              Docs
            </ExternalLink>
          )}
          {community.contributing && (
            <FileLink
              repo={repo}
              path={community.contributing}
              icon={UsersThreeIcon}
            >
              Contributing
            </FileLink>
          )}
          {community.conduct && (
            <FileLink repo={repo} path={community.conduct} icon={HeartIcon}>
              Code of conduct
            </FileLink>
          )}
          {community.security && (
            <FileLink
              repo={repo}
              path={community.security}
              icon={ShieldCheckIcon}
            >
              Security policy
            </FileLink>
          )}
          {community.changelog && (
            <FileLink
              repo={repo}
              path={community.changelog}
              icon={FileTextIcon}
            >
              Changelog
            </FileLink>
          )}
        </ul>
      </Section>

      {contributors.length > 0 && (
        <Section
          title="Contributors"
          aside={`${active} active in the last month`}
        >
          <Link
            {...insights}
            className="group -my-1 flex items-center gap-3 py-1"
          >
            <span className="flex -space-x-1.5">
              {contributors.slice(0, SHOWN_AVATARS).map((c) => (
                <Avatar
                  key={c.email}
                  handle={handleOf(c)}
                  className="size-7 text-xs ring-2 ring-card"
                />
              ))}
            </span>
            <span className="text-xs text-muted-foreground group-hover:text-foreground">
              <b className="font-medium text-foreground">
                {contributors.length}
              </b>{' '}
              in total
            </span>
          </Link>
        </Section>
      )}

      <Section title="Languages">
        <Languages repo={repo} />
      </Section>
    </aside>
  )
}
