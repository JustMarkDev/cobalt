import { Fragment, useState } from 'react'
import {
  CheckCircleIcon,
  ChevronDownIcon,
  MinusCircleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import type { Group, Level, Row } from '~/lib/compare'
import { groupLabel, levelLabel, products, rows } from '~/lib/compare'

const tone: Record<Level, string> = {
  yes: 'text-success',
  partly: 'text-warning',
  no: 'text-muted-foreground',
  unclear: 'text-muted-foreground',
}

/** The mark for a level. The words are there for screen readers and for the legend. */
export function LevelMark({
  level,
  className,
}: {
  level: Level
  className?: string
}) {
  const props = {
    'aria-label': levelLabel[level],
    role: 'img',
    className: cn('size-5 shrink-0', tone[level], className),
  }
  if (level === 'yes') return <CheckCircleIcon {...props} />
  if (level === 'partly') return <MinusCircleIcon {...props} />
  if (level === 'no') return <XCircleIcon {...props} />
  return <QuestionMarkCircleIcon {...props} />
}

export function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
      {(['yes', 'partly', 'no', 'unclear'] as const).map((l) => (
        <li key={l} className="inline-flex items-center gap-1.5">
          <LevelMark level={l} className="size-4" />
          {levelLabel[l]}
        </li>
      ))}
    </ul>
  )
}

/** Consecutive columns of the same group, for the header row above the names. */
const groups: Array<{ group: Group; span: number }> = products.reduce<
  Array<{ group: Group; span: number }>
>((acc, p) => {
  const last = acc.at(-1)
  if (last && last.group === p.group) last.span += 1
  else acc.push({ group: p.group, span: 1 })
  return acc
}, [])

/** A thin rule before the first column of each group. */
const startsGroup = new Set(
  products
    .filter((p, i) => i > 0 && products[i - 1].group !== p.group)
    .map((p) => p.id),
)

const colCount = products.length + 1

/** What each product does on one row, and the pages we read it on. */
function RowNotes({ row }: { row: Row }) {
  return (
    <div className="sticky left-0 w-[calc(100vw-3.25rem)] space-y-4 px-4 py-5 sm:w-auto sm:px-5">
      <p className="max-w-3xl text-sm text-muted-foreground">{row.why}</p>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => {
          const c = row.cells[p.id]
          return (
            <li key={p.id} className="flex gap-2.5 text-sm">
              <LevelMark level={c.level} className="mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p>
                  <b className="font-medium">{p.name}</b>
                  <span className="text-muted-foreground">
                    {' '}
                    · {levelLabel[c.level]}
                  </span>
                </p>
                <p className="text-muted-foreground">{c.text}</p>
                {c.sources && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                    {c.sources.map((s) => (
                      <li key={s.href}>
                        <a
                          href={s.href}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                        >
                          {s.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * One mark per cell, so the shape of it reads at a glance. Opening a row shows
 * why it matters, what each product does, and the page we read it on.
 */
export function CompareTable() {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  let lastTopic = ''
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card">
      <table className="w-full min-w-[46rem] text-sm lg:min-w-[60rem]">
        <caption className="sr-only">
          How source.code compares with established hosts and new ones built
          around agents. Open a row for notes and sources.
        </caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <td className="sticky left-0 z-10 bg-card" />
            {groups.map((g, i) => (
              <th
                key={i}
                scope="colgroup"
                colSpan={g.span}
                className={cn(
                  'px-2 pt-3 text-center font-normal',
                  g.group === 'us' && 'bg-muted/60',
                  i > 0 && 'border-l',
                )}
              >
                {groupLabel[g.group] || <span className="sr-only">Us</span>}
              </th>
            ))}
          </tr>
          <tr className="border-b">
            <th scope="col" className="sticky left-0 z-10 bg-card px-5 py-3">
              <span className="sr-only">Capability</span>
            </th>
            {products.map((p) => (
              <th
                key={p.id}
                scope="col"
                className={cn(
                  'px-2 pt-1 pb-3 text-center align-bottom font-medium',
                  p.id === 'us' && 'bg-muted/60',
                  startsGroup.has(p.id) && 'border-l',
                )}
              >
                <span className="block leading-tight">{p.name}</span>
                {p.note && (
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {p.note}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open.has(r.id)
            const showTopic = r.topic !== lastTopic
            lastTopic = r.topic
            return (
              <Fragment key={r.id}>
                {showTopic && (
                  <tr className="border-t">
                    <th
                      scope="rowgroup"
                      colSpan={colCount}
                      className="px-5 pt-4 pb-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
                    >
                      {r.topic}
                    </th>
                  </tr>
                )}
                <tr className={cn(isOpen && 'bg-muted/30')}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 w-40 min-w-40 bg-card p-0 text-left font-normal sm:w-auto"
                  >
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      aria-expanded={isOpen}
                      aria-controls={`compare-${r.id}`}
                      className="flex w-full items-start gap-2 px-3 py-3 text-left text-xs sm:px-5 sm:text-sm hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <ChevronDownIcon
                        aria-hidden="true"
                        className={cn(
                          'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-180',
                        )}
                      />
                      <span>{r.question}</span>
                    </button>
                  </th>
                  {products.map((p) => (
                    <td
                      key={p.id}
                      className={cn(
                        'px-2 py-3',
                        p.id === 'us' && 'bg-muted/60',
                        startsGroup.has(p.id) && 'border-l',
                      )}
                    >
                      <span className="flex justify-center">
                        <LevelMark level={r.cells[p.id].level} />
                      </span>
                    </td>
                  ))}
                </tr>
                <tr id={`compare-${r.id}`} hidden={!isOpen}>
                  <td colSpan={colCount} className="border-t bg-muted/30">
                    {isOpen && <RowNotes row={r} />}
                  </td>
                </tr>
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
