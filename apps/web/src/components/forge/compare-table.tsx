import { Popover } from '@base-ui/react/popover'
import {
  CheckCircleIcon,
  MinusCircleIcon,
  XCircleIcon,
} from '@heroicons/react/20/solid'
import { cn } from 'cn'
import type { Cell, Level, Product } from '~/lib/compare'
import { levelLabel, products, rows } from '~/lib/compare'

const tone: Record<Level, string> = {
  yes: 'text-success',
  partly: 'text-warning',
  no: 'text-muted-foreground/70',
  unclear: 'text-muted-foreground/40',
}

/** The mark for a level. The words are there for screen readers and the legend. */
function Mark({ level, className }: { level: Level; className?: string }) {
  const props = {
    'aria-hidden': true as const,
    className: cn('size-5 shrink-0', tone[level], className),
  }
  if (level === 'yes') return <CheckCircleIcon {...props} />
  if (level === 'partly') return <MinusCircleIcon {...props} />
  if (level === 'no') return <XCircleIcon {...props} />
  // Not documented: a quiet dash, so it reads as a gap rather than a verdict.
  return (
    <span {...props} className={cn(props.className, 'grid place-items-center')}>
      <span className="h-0.5 w-2.5 rounded-full bg-current" />
    </span>
  )
}

export function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
      {(['yes', 'partly', 'no', 'unclear'] as const).map((l) => (
        <li key={l} className="inline-flex items-center gap-1.5">
          <Mark level={l} className="size-4" />
          {levelLabel[l]}
        </li>
      ))}
    </ul>
  )
}

function NoteDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground ring-2 ring-card"
    />
  )
}

/**
 * A mark with a note opens it on hover, focus or tap, floating over the table
 * so nothing around it moves.
 */
function NoteMark({ cell, product }: { cell: Cell; product: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={60}
        closeDelay={80}
        aria-label={`${product}: ${levelLabel[cell.level]}. Show note`}
        className="relative inline-flex cursor-help rounded-full focus-ring"
      >
        <Mark level={cell.level} />
        <NoteDot />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} className="z-50">
          <Popover.Popup className="overlay-popup max-w-64 rounded-lg border bg-popover px-3 py-2 text-left text-xs leading-relaxed floating outline-none">
            <p className="font-medium text-foreground">
              {product}
              <span className="font-normal text-muted-foreground">
                , {levelLabel[cell.level].toLowerCase()}
              </span>
            </p>
            <p className="text-muted-foreground">{cell.note}</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function CellMark({ cell, product }: { cell: Cell; product: string }) {
  if (cell.note) return <NoteMark cell={cell} product={product} />
  return (
    <span
      role="img"
      aria-label={levelLabel[cell.level]}
      className="inline-flex"
    >
      <Mark level={cell.level} />
    </span>
  )
}

/** Our column carries the brand tint top to bottom. */
const ours = (id: Product) => id === 'us' && 'bg-brand/[0.07]'

/**
 * A checklist: one short line per feature, one mark per product. Marks that
 * need a word of explanation carry a dot and show it in a popover.
 */
export function CompareTable() {
  return (
    <div className="surface lit-edge overflow-hidden rounded-2xl border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] sm:min-w-[52rem] text-sm">
          <caption className="sr-only">
            How source.code compares with other code hosts, feature by feature.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 w-44 min-w-44 bg-card sm:w-[32%]"
              >
                <span className="sr-only">Feature</span>
              </th>
              {products.map((p) => (
                <th
                  key={p.id}
                  scope="col"
                  className={cn(
                    'px-2 pt-5 pb-4 text-center align-bottom font-medium',
                    p.id === 'us'
                      ? 'text-foreground shadow-[inset_0_2px_0_var(--brand)]'
                      : 'text-muted-foreground',
                    ours(p.id),
                  )}
                >
                  <span className="block leading-tight">{p.name}</span>
                  {p.note && (
                    <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground/80">
                      {p.note}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-card px-4 py-3.5 text-left font-normal sm:px-6"
                >
                  <span className="block font-medium text-foreground">
                    {r.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground sm:text-[13px]">
                    {r.detail}
                  </span>
                </th>
                {products.map((p) => (
                  <td
                    key={p.id}
                    className={cn('px-2 py-3.5 text-center', ours(p.id))}
                  >
                    <CellMark cell={r.cells[p.id]} product={p.name} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
