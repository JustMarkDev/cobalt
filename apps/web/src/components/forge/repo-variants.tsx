import { Popover } from '@base-ui/react/popover'
import {
  ChevronDownIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { CodeBrowser } from './repo-code-browser'
import { HistoryView } from './repo-history'
import { DownloadButton } from './download-button'
import { CopyField } from './repo-shell'
import { useDownload } from './repo-releases'
import type { Repo } from '~/lib/model/data'
import { GitBranchIcon } from '~/components/icons'
import { Button } from '~/components/ui/button'
import { Tip } from '~/components/ui/tooltip'
import { latestStable } from '~/lib/model/data'
import { useOpMaybe } from '~/lib/forge'

export function CodeActions({
  repo,
  onFind,
}: {
  repo: Repo
  onFind: () => void
}) {
  const release = latestStable(repo)
  const download = useDownload(repo)
  return (
    <>
      <span className="mr-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <GitBranchIcon className="size-4" />
        main
      </span>
      <Tip label="Go to file">
        <Button size="icon" aria-label="Go to file" onClick={onFind}>
          <MagnifyingGlassIcon />
        </Button>
      </Tip>
      <ClonePopover repo={repo} />
      {release && (
        <div className="max-sm:order-first max-sm:basis-full">
          <DownloadButton
            release={release}
            onDownload={(file) => download(release, file)}
          />
        </div>
      )}
    </>
  )
}

export function CodePage({
  repo,
  path,
  view,
  finding,
  onFinding,
}: {
  repo: Repo
  path?: string
  view?: 'history'
  finding: boolean
  onFinding: (open: boolean) => void
}) {
  const head = useOpMaybe('git.commits', {
    owner: repo.owner,
    repo: repo.name,
    limit: 1,
  })
  if (head === undefined)
    return <p className="py-10 text-sm text-muted-foreground">Loading…</p>
  if (!head?.data.length) return <EmptyRepo repo={repo} />
  return view === 'history' ? (
    <HistoryView repo={repo} />
  ) : (
    <CodeBrowser
      repo={repo}
      path={path}
      finding={finding}
      onFinding={onFinding}
    />
  )
}

function EmptyRepo({ repo }: { repo: Repo }) {
  const path = `${repo.owner}/${repo.name}`
  return (
    <div className="surface max-w-2xl space-y-4 rounded-2xl border bg-card p-6">
      <div>
        <h2 className="font-semibold">Nothing here yet</h2>
        <p className="text-sm text-muted-foreground">
          Push a commit and its files and history show up here.
        </p>
      </div>
      <CopyField
        value={`git remote add origin https://cobaltforge.dev/${path}.git`}
      />
      <CopyField value="git push -u origin main" />
    </div>
  )
}

function ClonePopover({ repo }: { repo: Repo }) {
  const path = `${repo.owner}/${repo.name}`
  return (
    <Popover.Root>
      <Popover.Trigger className="raised inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-3.5 text-sm hover:bg-muted">
        <CommandLineIcon className="size-4" />
        Clone
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="overlay-popup w-96 space-y-3 rounded-xl border bg-popover p-3 floating outline-none">
            {(
              [
                ['HTTPS', `https://cobaltforge.dev/${path}.git`],
                ['CLI', `cb repo clone ${path}`],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  {label}
                </div>
                <CopyField value={value} prefix="" />
              </div>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
