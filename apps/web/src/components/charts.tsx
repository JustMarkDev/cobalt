/**
 * The app's charts: ink on paper, with the brand accent as the data.
 *
 * Everything is SVG and HTML drawn from the theme tokens, so a chart follows
 * light and dark like the rest of the page and renders the same on the server.
 * Plots are drawn in a 0–100 box stretched to their parent
 * (`preserveAspectRatio="none"`, strokes that do not scale), so nothing is
 * measured and nothing waits for the browser. Text sits in HTML over the plot,
 * so it is never stretched.
 *
 * Marks: 2px lines, a 10% wash under an area, columns at most 24px wide with a
 * 4px rounded end, 2px gaps between touching marks, hairline solid grid lines.
 * Series colours come in a fixed order (`--chart-1` … `--chart-4`, then
 * `--chart-5` for "Other"); text always wears text colours. Each chart carries
 * a visually hidden table of its numbers for screen readers.
 *
 * Trend, grouped bars and sparkline fill a parent with a height. Share and
 * ranked bars size to their content.
 */
import * as React from 'react'
import { cn } from 'cn'
import { scaleLinear } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'

export type Point = { label: string; value: number }

const SERIES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
]
const OTHER = 'var(--chart-5)'

const full = new Intl.NumberFormat('en')
const short = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
/** Ticks in full under 10,000, compact on an axis that reaches it. */
const tickFormat = (top: number) => (n: number) =>
  top >= 10_000 ? short.format(n) : full.format(n)

/** Clean ticks from zero, and the top of the axis they imply. */
function yAxis(values: Array<number>) {
  const max = Math.max(0, ...values)
  const scale = scaleLinear()
    .domain([0, max || 1])
    .nice(4)
  const ticks = scale.ticks(4)
  const top = scale.domain()[1]
  return { ticks, top, format: tickFormat(top) }
}

/** At most `most` evenly spaced indexes, always the first and the last. */
function spaced(n: number, most: number) {
  if (n <= most) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil((n - 1) / (most - 1))
  const out: Array<number> = []
  for (let i = 0; i < n - 1; i += step) out.push(i)
  if (n - 1 - out[out.length - 1] < step / 2) out.pop()
  out.push(n - 1)
  return out
}

/** A label along the bottom, kept inside the plot at the two ends. */
function XLabel({ at, children }: { at: number; children: React.ReactNode }) {
  const shift = at < 8 ? '0%' : at > 92 ? '-100%' : '-50%'
  return (
    <span
      className="absolute top-0 whitespace-nowrap"
      style={{ left: `${at}%`, transform: `translateX(${shift})` }}
    >
      {children}
    </span>
  )
}

function Grid({
  ticks,
  top,
  format,
  labels,
}: {
  ticks: Array<number>
  top: number
  format: (n: number) => string
  labels: boolean
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute right-0 left-0 border-t border-border"
          style={{ top: `${100 - (t / top) * 100}%` }}
        >
          {labels && (
            <span className="absolute -top-2 right-full mr-2 text-[11px] leading-none text-muted-foreground tabular-nums">
              {format(t)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function Tip({
  at,
  children,
}: {
  /** Horizontal position of the thing it describes, in percent. */
  at: number
  children: React.ReactNode
}) {
  const side = at > 60 ? { right: `${100 - at}%` } : { left: `${at}%` }
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-10 mx-2 min-w-24 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm"
      style={side}
    >
      {children}
    </div>
  )
}

function Table({
  caption,
  head,
  rows,
}: {
  caption: string
  head: Array<string>
  rows: Array<Array<string | number>>
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) =>
              j === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>,
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Empty({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center text-xs text-muted-foreground',
        className,
      )}
    >
      Nothing yet
    </div>
  )
}

/**
 * Which of `n` evenly spread points the pointer is over, from a pointer or
 * arrow-key event on the plot. Points sit at band centres when `banded`.
 */
function useHover(n: number, banded: boolean) {
  const [index, setIndex] = React.useState<number | null>(null)
  const pick = (e: React.PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / Math.max(1, box.width)
    const i = banded ? Math.floor(x * n) : Math.round(x * (n - 1))
    setIndex(Math.min(n - 1, Math.max(0, i)))
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const d = e.key === 'ArrowRight' ? 1 : -1
      setIndex((i) => Math.min(n - 1, Math.max(0, (i ?? (d > 0 ? -1 : n)) + d)))
    } else if (e.key === 'Escape') setIndex(null)
  }
  return {
    index,
    bind: {
      tabIndex: 0,
      onPointerMove: pick,
      onPointerDown: pick,
      onPointerLeave: () => setIndex(null),
      onKeyDown: key,
      onBlur: () => setIndex(null),
    },
  }
}

// ---------------------------------------------------------------------------

/** One series over time: a line on a soft wash, with a crosshair on hover. */
export function TrendChart({
  data,
  unit = '',
  axes = true,
  className,
}: {
  data: Array<Point>
  /** What is counted, for the tooltip and the hidden table ("Commits"). */
  unit?: string
  /** Off for a compact card: no tick labels, no grid. */
  axes?: boolean
  className?: string
}) {
  const n = data.length
  const { index, bind } = useHover(n, false)
  if (n === 0) return <Empty className={className} />
  const { ticks, top, format } = yAxis(data.map((d) => d.value))
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100)
  const y = (v: number) => 100 - (v / top) * 100
  const pts = data.map((d, i) => [x(i), y(d.value)] as [number, number])
  const path = line().curve(curveMonotoneX)(pts) ?? ''
  const wash = area().curve(curveMonotoneX).y0(100)(pts) ?? ''
  const at = index === null ? null : data[index]
  const last = data[n - 1]

  return (
    <div className={cn('flex h-full w-full flex-col', className)}>
      <div className={cn('relative min-h-0 flex-1', axes && 'ml-9 mt-2')}>
        {axes && <Grid ticks={ticks} top={top} format={format} labels />}
        <div
          {...bind}
          role="img"
          aria-label={`${unit || 'Values'}, ${data[0].label} to ${last.label}. Latest ${full.format(last.value)}. Use the arrow keys to read each point.`}
          className="absolute inset-0 touch-pan-y rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            <path d={wash} fill="var(--brand)" fillOpacity={0.14} />
            <path
              d={path}
              fill="none"
              stroke="var(--brand-ink)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {at && index !== null && (
            <>
              <div
                aria-hidden
                className="absolute top-0 bottom-0 border-l border-foreground/25"
                style={{ left: `${x(index)}%` }}
              />
              <div
                aria-hidden
                className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-ink ring-2 ring-card"
                style={{ left: `${x(index)}%`, top: `${y(at.value)}%` }}
              />
              <Tip at={x(index)}>
                <div className="text-muted-foreground">{at.label}</div>
                <div className="font-medium tabular-nums">
                  {full.format(at.value)}
                  {unit && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      {unit.toLowerCase()}
                    </span>
                  )}
                </div>
              </Tip>
            </>
          )}
        </div>
      </div>
      {axes && (
        <div
          aria-hidden
          className="relative mt-1.5 ml-9 h-4 text-[11px] leading-none text-muted-foreground"
        >
          {spaced(n, 6).map((i) => (
            <XLabel key={i} at={x(i)}>
              {data[i].label}
            </XLabel>
          ))}
        </div>
      )}
      <Table
        caption={unit || 'Values'}
        head={['', unit || 'Value']}
        rows={data.map((d) => [d.label, d.value])}
      />
    </div>
  )
}

/** Several series side by side per label: columns grouped on one baseline. */
export function GroupedBars({
  data,
  series,
  className,
}: {
  data: Array<Record<string, string | number>>
  /** In a fixed order: the first takes the first series colour, and so on. */
  series: Array<{ key: string; label: string }>
  className?: string
}) {
  const n = data.length
  const { index, bind } = useHover(n, true)
  if (n === 0) return <Empty className={className} />
  const value = (row: Record<string, string | number>, k: string) =>
    Number(row[k] ?? 0)
  const { ticks, top, format } = yAxis(
    data.flatMap((row) => series.map((s) => value(row, s.key))),
  )
  const color = (i: number) => SERIES[i] ?? OTHER
  const at = index === null ? null : data[index]

  return (
    <div className={cn('flex h-full w-full flex-col', className)}>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-[3px]"
              style={{ background: color(i) }}
            />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="relative mt-2 ml-9 min-h-0 flex-1">
        <Grid ticks={ticks} top={top} format={format} labels />
        <div
          {...bind}
          role="img"
          aria-label={`${series.map((s) => s.label).join(' and ')} by ${String(data[0].label)} to ${String(data[n - 1].label)}. Use the arrow keys to read each group.`}
          className="absolute inset-0 grid touch-pan-y rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {data.map((row, i) => (
            <div
              key={i}
              aria-hidden
              className={cn(
                'flex items-end justify-center gap-0.5 px-[15%]',
                index === i && 'bg-foreground/[0.04]',
              )}
            >
              {series.map((s, j) => (
                <div
                  key={s.key}
                  className="max-w-6 min-w-0 flex-1 rounded-t-[4px]"
                  style={{
                    height: `${(value(row, s.key) / top) * 100}%`,
                    background: color(j),
                  }}
                />
              ))}
            </div>
          ))}
          {at && index !== null && (
            <Tip at={((index + 0.5) / n) * 100}>
              <div className="mb-1 text-muted-foreground">
                {String(at.label)}
              </div>
              {series.map((s, j) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-[2px]"
                    style={{ background: color(j) }}
                  />
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="ml-auto pl-3 font-medium tabular-nums">
                    {full.format(value(at, s.key))}
                  </span>
                </div>
              ))}
            </Tip>
          )}
        </div>
      </div>
      <div
        aria-hidden
        className="mt-1.5 ml-9 flex text-[11px] leading-none text-muted-foreground"
      >
        {data.map((row, i) => (
          <span key={i} className="flex-1 truncate text-center">
            {String(row.label)}
          </span>
        ))}
      </div>
      <Table
        caption={series.map((s) => s.label).join(' and ')}
        head={['', ...series.map((s) => s.label)]}
        rows={data.map((row) => [
          String(row.label),
          ...series.map((s) => value(row, s.key)),
        ])}
      />
    </div>
  )
}

/**
 * Parts of a whole: one segmented bar, and the parts listed largest first
 * with their share. Past four parts the rest are folded into "Other".
 */
export function ShareBar({
  data,
  className,
}: {
  data: Array<{ name: string; value: number }>
  className?: string
}) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0)
  if (total === 0) return <Empty className={cn('h-16', className)} />
  const sorted = [...data]
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
  const parts =
    sorted.length > SERIES.length
      ? [
          ...sorted.slice(0, SERIES.length - 1),
          {
            name: 'Other',
            value: sorted
              .slice(SERIES.length - 1)
              .reduce((s, d) => s + d.value, 0),
          },
        ]
      : sorted
  const color = (i: number, name: string) =>
    name === 'Other' && i === parts.length - 1 ? OTHER : SERIES[i]
  const pct = (v: number) => {
    const p = (v / total) * 100
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
  }

  return (
    <div className={cn('w-full space-y-3', className)}>
      <div
        aria-hidden
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-full"
      >
        {parts.map((p, i) => (
          <div
            key={p.name}
            title={`${p.name}: ${pct(p.value)}`}
            style={{
              flexGrow: p.value,
              flexBasis: 0,
              minWidth: 3,
              background: color(i, p.name),
            }}
          />
        ))}
      </div>
      <ul className="space-y-1.5 text-sm">
        {parts.map((p, i) => (
          <li key={p.name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: color(i, p.name) }}
            />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span
              className="text-muted-foreground tabular-nums"
              title={full.format(p.value)}
            >
              {pct(p.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A profile across a few categories: horizontal bars, largest first. */
export function RankedBars({
  data,
  className,
}: {
  data: Array<Point>
  className?: string
}) {
  const max = Math.max(0, ...data.map((d) => d.value))
  if (max === 0) return <Empty className={cn('h-16', className)} />
  const sorted = [...data].sort((a, b) => b.value - a.value)
  return (
    <ul className={cn('w-full space-y-2.5 text-sm', className)}>
      {sorted.map((d) => (
        <li
          key={d.label}
          className="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-2"
        >
          <span className="truncate text-muted-foreground">{d.label}</span>
          <span
            aria-hidden
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full rounded-full bg-brand-ink"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">
            {full.format(d.value)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A trend in a dense row: line and end dot, no axes. */
export function Sparkline({
  data,
  label = 'Trend',
  className,
}: {
  data: Array<number>
  /** What the line is, for screen readers ("Downloads per day"). */
  label?: string
  className?: string
}) {
  const n = data.length
  if (n === 0) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  // A little headroom so the 2px line and the end dot are not cut off.
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100)
  const y = (v: number) => 92 - ((v - min) / span) * 84
  const pts = data.map((v, i) => [x(i), y(v)] as [number, number])
  const path = line().curve(curveMonotoneX)(pts) ?? ''
  const wash = area().curve(curveMonotoneX).y0(100)(pts) ?? ''
  return (
    <div
      role="img"
      aria-label={`${label}: ${full.format(data[0])} to ${full.format(data[n - 1])}`}
      className={cn('relative h-full w-full', className)}
    >
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        <path d={wash} fill="var(--brand)" fillOpacity={0.12} />
        <path
          d={path}
          fill="none"
          stroke="var(--brand-ink)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-ink ring-2 ring-card"
        style={{ left: `${x(n - 1)}%`, top: `${y(data[n - 1])}%` }}
      />
    </div>
  )
}
