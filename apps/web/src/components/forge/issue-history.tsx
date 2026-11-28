import { Link } from '@tanstack/react-router'
import { ArrowsLeftRightIcon } from '@phosphor-icons/react'
import { Chip, Panel, SectionLabel } from './bits'
import type { Repo } from '~/lib/model/data'
import { useOpMaybe } from '~/lib/forge'

export function IssueHistory({ repo, n }: { repo: Repo; n: number }) {
  const at = { owner: repo.owner, repo: repo.name }
  const timeline = useOpMaybe('issues.timeline', {
    ...at,
    number: n,
    limit: 200,
  })
  if (!timeline) return null
  const entries = timeline.data
  const refs = entries.filter((e) => e.kind === 'reference')
  if (!refs.length) return null
  return (
    <section className="space-y-3">
      <SectionLabel>Linked changes</SectionLabel>
      {refs.map((e) =>
        e.item.object === 'reference' ? (
          <Panel key={e.id} className="flex items-center gap-2 p-3 text-sm">
            <ArrowsLeftRightIcon className="size-4 text-muted-foreground" />
            <Link
              to="/$handle/$repo/$tab"
              params={{ handle: repo.owner, repo: repo.name, tab: 'changes' }}
              search={{ n: e.item.change }}
              className="min-w-0 flex-1 truncate font-medium hover:underline"
            >
              #{e.item.change} {e.item.title}
            </Link>
            <Chip tone={e.item.closes ? 'success' : 'muted'}>
              {e.item.closes ? 'fixes this' : 'refers to this'}
            </Chip>
            <Chip tone="outline">{e.item.state}</Chip>
          </Panel>
        ) : null,
      )}
    </section>
  )
}
