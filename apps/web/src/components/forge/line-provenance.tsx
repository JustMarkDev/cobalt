import type * as React from 'react'
import { Link } from '@tanstack/react-router'
import { receiptText } from './bits'
import type { Repo } from '~/lib/model/data'
import { Modal } from '~/components/ui/dialog'
import { useOpMaybe } from '~/lib/forge'
import { timeAgo } from '~/lib/repo'

/**
 * "Why is this line here?": from a line of code to the commit that wrote
 * it, the change it landed through, the patch set, and that patch set's
 * receipt: the machine, the tool and the model it was written with.
 */
export function LineProvenance({
  repo,
  path,
  line,
  gitRef,
  change,
  onClose,
}: {
  repo: Repo
  path: string
  line: number | null
  gitRef?: string
  /** Ask about the line in this change's newest patch set. */
  change?: number
  onClose: () => void
}) {
  const open = line !== null
  const p = useOpMaybe(
    'repos.provenance',
    {
      owner: repo.owner,
      repo: repo.name,
      path,
      line: line ?? 1,
      ...(change ? { change } : gitRef ? { ref: gitRef } : {}),
    },
    open,
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Why is line ${line ?? ''} here?`}
      description={path}
      wide
    >
      {p === undefined ? (
        <p className="text-sm text-muted-foreground">Following the line…</p>
      ) : p === null ? (
        <p className="text-sm text-muted-foreground">
          This line could not be followed back.
        </p>
      ) : (
        <dl className="space-y-4 text-sm">
          {p.commit && (
            <Row label="Commit">
              <Link
                to="/$handle/$repo/commit/$sha"
                params={{
                  handle: repo.owner,
                  repo: repo.name,
                  sha: p.commit.sha,
                }}
                className="font-medium hover:underline"
              >
                {p.commit.message.split('\n')[0]}
              </Link>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{p.commit.sha.slice(0, 7)}</span> by{' '}
                {p.commit.author.name}, {timeAgo(p.commit.date)}
              </p>
            </Row>
          )}
          <Row label="Change">
            {p.change ? (
              <Link
                to="/$handle/$repo/$tab"
                params={{ handle: repo.owner, repo: repo.name, tab: 'changes' }}
                search={{ n: p.change.number }}
                className="font-medium hover:underline"
              >
                #{p.change.number} {p.change.title}
              </Link>
            ) : (
              <span className="text-muted-foreground">
                No change here brought this line in.
              </span>
            )}
            {p.patch_set !== null && (
              <p className="text-xs text-muted-foreground">
                Written in patch set {p.patch_set}
              </p>
            )}
          </Row>
          <Row label="Receipt">
            {receiptText(p.via) ? (
              <p>{receiptText(p.via)}</p>
            ) : (
              <span className="text-muted-foreground">
                Nothing was declared for it.
              </span>
            )}
            {p.via?.model && (
              <p className="text-xs text-muted-foreground">
                The model is what the tool declared; it is not verified.
              </p>
            )}
          </Row>
        </dl>
      )}
    </Modal>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="min-w-0 space-y-1">{children}</dd>
    </div>
  )
}
