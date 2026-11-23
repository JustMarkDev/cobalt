import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownTrayIcon,
  ArrowRightIcon,
  BellIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  CpuChipIcon,
  KeyIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShieldCheckIcon,
  StarIcon,
  UsersIcon,
} from '@heroicons/react/24/outline'
import type { BrandId } from '~/components/brand'
import type { BadgeTone } from '~/components/ui/badge'
import {
  GitBranchIcon,
  GitCommitIcon,
  GitForkIcon,
  GitMergeIcon,
} from '~/components/icons'
import { BrandLogo, BrandTile, brandName, brands } from '~/components/brand'
import {
  GroupedBars,
  RankedBars,
  ShareBar,
  Sparkline,
  TrendChart,
} from '~/components/charts'
import { Kbd, LangDot, Tile } from '~/components/forge/bits'
import { DeveloperRow, RepoCard, RepoRow } from '~/components/forge/repo-card'
import { SoftwareCard } from '~/components/forge/software-card'
import { CopyField } from '~/components/forge/repo-shell'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Callout } from '~/components/ui/callout'
import { Modal } from '~/components/ui/dialog'
import { Field, Input, Textarea } from '~/components/ui/input'
import { Dropdown, MenuItem, MenuSeparator } from '~/components/ui/menu'
import { Switch, SwitchRow } from '~/components/ui/switch'
import { Segmented, StateTabs } from '~/components/ui/tabs'
import { Tip } from '~/components/ui/tooltip'
import { Select, SelectItem } from '~/components/ui/select'
import { sampleDeveloper, sampleRepos } from '~/components/forge/design-samples'

export const Route = createFileRoute('/design')({
  head: () => ({ meta: [{ title: 'Design system · source.code' }] }),
  component: Design,
})

const sections = [
  ['principles', 'Principles'],
  ['colour', 'Colour'],
  ['type', 'Type and shape'],
  ['accessibility', 'Accessibility'],
  ['brand', 'Brand logos'],
  ['icons', 'Icons'],
  ['buttons', 'Buttons'],
  ['badges', 'Badges'],
  ['forms', 'Forms'],
  ['navigation', 'Navigation'],
  ['overlays', 'Overlays'],
  ['charts', 'Charts'],
  ['patterns', 'Patterns'],
] as const

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-header space-y-5">
      <div className="space-y-1 border-b pb-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && (
          <div className="max-w-[65ch] text-sm text-muted-foreground">
            {typeof note === 'string' ? <p>{note}</p> : note}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}

/** A specimen with a caption and where it lives in the code. */
function Specimen({
  label,
  source,
  children,
  className,
}: {
  label: string
  source?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        {source && (
          <code className="font-mono text-muted-foreground">{source}</code>
        )}
      </div>
      <div
        className={
          className ??
          'flex flex-wrap items-center gap-3 surface rounded-2xl border bg-card p-5'
        }
      >
        {children}
      </div>
    </div>
  )
}

const swatches: Array<[string, string, string]> = [
  ['background', 'bg-background', 'The page'],
  ['card', 'bg-card', 'Panels and rows'],
  ['muted', 'bg-muted', 'Quiet fills, hover'],
  ['primary', 'bg-primary', 'Ink: default buttons'],
  ['brand', 'bg-brand', 'The one primary action'],
  ['border', 'bg-border', 'Hairlines'],
]
const tones: Array<[BadgeTone, string]> = [
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['info', 'bg-info'],
  ['merged', 'bg-merged'],
]

const sampleSeries = Array.from({ length: 12 }, (_, i) => ({
  label: `W${i + 1}`,
  value: 20 + ((i * 17) % 23) + i * 2,
}))

function Design() {
  const [on, setOn] = React.useState(true)
  const [tab, setTab] = React.useState<'a' | 'b' | 'c'>('a')
  const [mode, setMode] = React.useState<'list' | 'grid'>('list')
  const [open, setOpen] = React.useState(false)
  const logoIds = Object.keys(brands) as Array<BrandId>

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[180px_minmax(0,1fr)]">
      <nav
        aria-label="On this page"
        className="hidden space-y-0.5 text-sm lg:sticky lg:top-header lg:block lg:self-start"
      >
        {sections.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="block rounded-lg px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="min-w-0 space-y-16">
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">
              Design system
            </h1>
          </div>
          <p className="max-w-[65ch] text-muted-foreground">
            Everything the product is built from, in one place. Components are
            shadcn/ui underneath, on Base UI, restyled with our own tokens and
            variants. Icons are Heroicons. Charts are our own SVG. Brand logos
            are the vendors&apos; own.
          </p>
          {/* Below lg there is no side index: the sections as one row of
              chips that scrolls sideways. */}
          <nav
            aria-label="On this page"
            className="scroll-fade-x -mx-6 overflow-x-auto px-6 pt-2 pb-1 [scrollbar-width:none] lg:hidden"
          >
            <ul className="flex w-max gap-2">
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="surface focus-ring flex h-9 items-center rounded-full border bg-card px-3.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <Section
          id="principles"
          title="Principles"
          note="Seven rules that decide most design questions."
        >
          <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              [
                'One next step',
                'Each screen has one primary action, drawn in brand cobalt. Everything else is quiet.',
              ],
              [
                'Structure is felt, not seen',
                'Whitespace and weight separate things before lines and boxes do. Borders are hairlines.',
              ],
              [
                'Earn attention',
                'Icons, colour and badges appear only when they carry meaning. Most rows are plain text.',
              ],
              [
                'Say it in words',
                'Plain labels in sentence case. No decoration in headings, no jargon in buttons.',
              ],
              [
                'Same everywhere',
                'A thing you can connect, a thing you can toggle, a thing that failed: each looks the same on every page.',
              ],
              [
                'Readable by everyone',
                'Running text is never under 12px, lines of about 68 characters, text at 4.5 to 1 contrast or better. Colour never carries meaning alone.',
              ],
              [
                'Reachable any way',
                'Every control works with a keyboard, shows one focus outline (the command palette field, focused as it opens, is marked by its caret and highlighted row) and sits in a target of at least 24px. A page never scrolls sideways on a phone.',
              ],
            ].map(([t, d], i) => (
              <li
                key={t}
                className="space-y-1 surface rounded-2xl border bg-card p-4"
              >
                <div className="font-mono text-xs text-muted-foreground">
                  0{i + 1}
                </div>
                <div className="text-sm font-medium">{t}</div>
                <p className="text-sm text-muted-foreground">{d}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          id="colour"
          title="Colour"
          note="Semantic tokens that flip with the theme, so components never need dark: variants. Brand cobalt is for the primary action, the current item and charts."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {swatches.map(([name, cls, note]) => (
              <div key={name} className="space-y-2">
                <div className={`h-14 rounded-xl border ${cls}`} />
                <div className="text-sm font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{note}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {tones.map(([name, cls]) => (
              <span key={name} className="flex items-center gap-2 text-sm">
                <span className={`size-3 rounded-full ${cls}`} />
                {name}
              </span>
            ))}
          </div>
        </Section>

        <Section
          id="type"
          title="Type and shape"
          note={
            <ul className="list-disc space-y-1.5 pl-4 marker:text-muted-foreground/50">
              <li>
                Inter Tight for text, Geist Mono for code, names and ids.
                Running text is never set below 12px; chart ticks are 11px.
              </li>
              <li>
                Radius by role: controls 12px (rounded-lg), menus 17.2px
                (rounded-xl), panels 21.6px (rounded-2xl). Blocks inside a panel
                (lists, callouts, code) are rounded-xl. Tags and labels are
                pills; badges, small chips and tooltips are rounded-sm; keyboard
                keys (kbd), checkboxes and the logo mark are rounded-xs (5px);
                radios and range thumbs are round. The base radius is in px, so
                corners stay put when text is zoomed.
              </li>
              <li>
                Anything nested close is concentric: inner = outer minus the
                gap, so a tab thumb is 8px. The first and last rows of a clipped
                list follow the panel&apos;s corners.
              </li>
              <li>
                Depth has five steps: well (recessed: fields, tracks, code and
                hints in a panel), surface (panels), raised (keys you press),
                thumb (the selected segment) and floating (menus, dialogs; tip
                for tooltips). Content on a panel is flat. Where opaque cells
                cover a panel&apos;s top edge, lit-edge draws it again.
              </li>
              <li>
                Never put a ring-* on an elevated control: rings are box-shadows
                and replace the elevation. Focus is an outline (focus-ring;
                focus-ring-inset for flush rows; row-link when the whole row is
                one link). The command palette&apos;s field is the one
                exception: it is focused as the palette opens, and its caret and
                highlighted row mark the place.
              </li>
              <li>
                A tab strip that overflows shades the inside of its rim at the
                side with more to scroll, as if the tabs slid under it; the
                track itself stays whole.
              </li>
            </ul>
          }
        >
          <div className="space-y-4 surface rounded-2xl border bg-card p-5">
            <div className="text-2xl font-semibold tracking-tight">
              Page title, 24 semibold
            </div>
            <div className="text-lg font-semibold tracking-tight">
              Section title, 18 semibold
            </div>
            <div className="text-sm font-medium">Block heading, 14 medium</div>
            <p className="text-sm">
              Body text, 14. The default for almost everything.
            </p>
            <p className="text-sm text-muted-foreground">
              Secondary text, 14, muted. Explains the thing above it.
            </p>
            <p className="text-xs text-muted-foreground">
              Caption, 12, the smallest size. Hints, timestamps, badges.
            </p>
            <p className="font-mono text-xs">dana/gitfs · #216 · v1.4.0</p>
          </div>
          <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {(
              [
                [
                  'well',
                  'Pressed in: troughs, inputs',
                  'well h-9 rounded-lg bg-muted/70',
                ],
                [
                  'surface',
                  'A panel at rest',
                  'surface h-16 rounded-2xl border bg-card',
                ],
                [
                  'raised',
                  'A key you press',
                  'raised h-9 rounded-lg border bg-card',
                ],
                ['thumb', 'The selected segment', ''],
                [
                  'floating',
                  'Menus and dialogs',
                  'floating h-16 rounded-xl border bg-popover',
                ],
              ] as const
            ).map(([name, note, cls]) => (
              <li key={name} className="space-y-2 text-xs">
                <div className="flex h-16 flex-col justify-end">
                  {name === 'thumb' ? (
                    <div className="trough flex h-9">
                      <div className="thumb flex-1" />
                      <div className="flex-1" />
                    </div>
                  ) : (
                    <div className={cls} />
                  )}
                </div>
                <div className="font-medium">{name}</div>
                <div className="text-muted-foreground">{note}</div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          id="accessibility"
          title="Accessibility"
          note="The rules that make the product usable by a keyboard, a screen reader, a small screen and tired eyes. Most are enforced by the components, so a page gets them for free."
        >
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Specimen
              label="Focus outline"
              source="app.css, focus-ring"
              className="flex flex-wrap items-center gap-3 surface rounded-2xl border bg-card p-5"
            >
              <Button className="outline-2 outline-offset-2 outline-ring outline-solid">
                Focused
              </Button>
              <span className="max-w-[28ch] text-sm text-muted-foreground">
                2px, offset 2px on every control. A control that fills its
                container draws it 2px inside (focus-ring-inset). A component
                that sets outline-none adds focus-ring to get it back.
              </span>
            </Specimen>
            <Specimen
              label="Target size"
              source="Button sizes"
              className="flex flex-wrap items-end gap-4 surface rounded-2xl border bg-card p-5"
            >
              {(
                [
                  ['25', 'size-6', 'minimum'],
                  ['34', 'h-8 w-12', 'sm'],
                  ['38', 'h-9 w-12', 'md'],
                  ['46', 'h-11 w-12', 'lg'],
                ] as const
              ).map(([px, box, name]) => (
                <div key={px} className="space-y-1.5 text-center">
                  <div
                    className={`${box} ${px === '25' ? 'rounded-sm' : 'rounded-lg'} border border-dashed border-foreground/40 bg-muted`}
                  />
                  <div className="font-mono text-xs text-muted-foreground">
                    {px}px {name}
                  </div>
                </div>
              ))}
            </Specimen>
            <Specimen
              label="Contrast"
              source="Badge tones"
              className="flex flex-wrap items-center gap-2 surface rounded-2xl border bg-card p-5"
            >
              {tones.map(([name]) => (
                <Badge key={name} tone={name}>
                  {name}
                </Badge>
              ))}
              <p className="basis-full text-sm text-muted-foreground">
                Every tone is at least 4.5 to 1 on its own tint, in light and
                dark. A status is also a word, never colour alone.
              </p>
            </Specimen>
            <Specimen
              label="Keyboard"
              source="Base UI and our tabs"
              className="space-y-2 surface rounded-2xl border bg-card p-5 text-sm"
            >
              {(
                [
                  ['Tab', 'Move to the next control'],
                  ['← →', 'Move between tabs'],
                  ['↑ ↓', 'Move in a menu'],
                  ['Enter', 'Choose'],
                  ['Esc', 'Close a menu or dialog'],
                ] as const
              ).map(([k, d]) => (
                <div key={k} className="flex items-center gap-3">
                  <span className="w-14">
                    <Kbd>{k}</Kbd>
                  </span>
                  <span className="text-muted-foreground">{d}</span>
                </div>
              ))}
            </Specimen>
          </div>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm text-muted-foreground sm:grid-cols-2">
            <li>
              A <b className="font-medium text-foreground">skip link</b> is the
              first stop on every page.
            </li>
            <li>
              One <b className="font-medium text-foreground">h1</b> a page, and
              headings never skip a level.
            </li>
            <li>
              Menus are <b className="font-medium text-foreground">ours</b>,
              never the browser&apos;s, so they look and behave the same.
            </li>
            <li>
              Things that scroll sideways can be{' '}
              <b className="font-medium text-foreground">
                scrolled by keyboard
              </b>
              .
            </li>
            <li>
              Nothing is dimmed to say it is secondary. Use the muted colour,
              which is checked.
            </li>
            <li>
              Lines of text stop at{' '}
              <b className="font-medium text-foreground">68 characters</b>.
            </li>
          </ul>
        </Section>

        <Section
          id="brand"
          title="Brand logos"
          note="Simple Icons where the vendor is listed there, the vendor's own icon file otherwise. Vector marks get a colour for each theme, with at least 4:1 against the card in light and 4.5:1 in dark. A vendor file that is a dark mark on a transparent background is lightness-flipped in dark. Hosts show only on private screens."
        >
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {logoIds.map((id) => (
              <li
                key={id}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm"
              >
                <BrandLogo id={id} />
                <span className="truncate">{brandName(id)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          id="icons"
          title="Icons"
          note="Heroicons, 24 outline, sized with size-4 in text and size-5 on tiles. Heroicons has no version-control glyphs, so four are drawn to match."
        >
          <Specimen label="Heroicons" source="@heroicons/react/24/outline">
            {[
              MagnifyingGlassIcon,
              BellIcon,
              PlusIcon,
              Cog6ToothIcon,
              StarIcon,
              LockClosedIcon,
              KeyIcon,
              ShieldCheckIcon,
              CpuChipIcon,
              CommandLineIcon,
              UsersIcon,
              CheckCircleIcon,
              ArrowDownTrayIcon,
              ArrowRightIcon,
            ].map((Icon, i) => (
              <Icon key={i} className="size-5" />
            ))}
          </Specimen>
          <Specimen
            label="Version control, drawn to match"
            source="~/components/icons"
          >
            <GitBranchIcon className="size-5" />
            <GitCommitIcon className="size-5" />
            <GitForkIcon className="size-5" />
            <GitMergeIcon className="size-5" />
          </Specimen>
        </Section>

        <Section
          id="buttons"
          title="Buttons"
          note="One brand button per screen. Variants: brand, default, outline, ghost, danger, link."
        >
          <Specimen label="Variants" source="~/components/ui/button">
            <Button variant="brand">Land change</Button>
            <Button variant="default">Default</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Delete</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
          </Specimen>
          <Specimen label="Sizes and icons">
            <Button size="sm">Small</Button>
            <Button>Medium</Button>
            <Button size="lg" variant="brand">
              Large
            </Button>
            <Button>
              <PlusIcon /> With icon
            </Button>
            <Tip label="Settings">
              <Button size="icon" aria-label="Settings">
                <Cog6ToothIcon />
              </Button>
            </Tip>
          </Specimen>
        </Section>

        <Section
          id="badges"
          title="Badges"
          note="Status and metadata. Colour means something: green is good, amber needs a look, red is broken."
        >
          <Specimen label="Tones" source="~/components/ui/badge">
            {(
              [
                'muted',
                'outline',
                'success',
                'warning',
                'danger',
                'info',
                'merged',
                'brand',
              ] as const
            ).map((t) => (
              <Badge key={t} tone={t}>
                {t}
              </Badge>
            ))}
          </Specimen>
          <Specimen label="Other small parts">
            <Kbd>⌘K</Kbd>
            <LangDot language="Rust" />
            <LangDot language="TypeScript" />
            <Tile name="Dana" round />
            <Tile name="gitfs" />
          </Specimen>
        </Section>

        <Section
          id="forms"
          title="Forms"
          note="A label, a control, one line of help. That is every form. Menus are ours, never the browser's."
        >
          <div className="grid grid-cols-1 gap-5 surface rounded-2xl border bg-card p-5 sm:grid-cols-2">
            <Field label="Name" hint="Letters, numbers and dashes.">
              <Input defaultValue="gitfs" />
            </Field>
            <Field label="Visibility">
              <Select defaultValue="public">
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Textarea defaultValue="Git over object storage." />
            </Field>
            <div className="space-y-4 sm:col-span-2">
              <SwitchRow
                checked={on}
                onChange={setOn}
                label="Sign release files"
                hint="Adds a signature and checksum to every asset."
              />
              <div className="flex items-center gap-3 text-sm">
                <Switch
                  checked={!on}
                  onCheckedChange={(v) => setOn(!v)}
                  aria-label="Bare switch"
                />{' '}
                A bare switch
              </div>
            </div>
            <div className="sm:col-span-2">
              <CopyField value="sx change create" />
            </div>
          </div>
        </Section>

        <Section
          id="navigation"
          title="Navigation"
          note="Tabs for places (each is a link), segmented controls for modes."
        >
          <Specimen
            label="State tabs"
            source="~/components/ui/tabs"
            className="surface rounded-2xl border bg-card p-5"
          >
            <div className="w-full space-y-5">
              <StateTabs
                label="Example"
                value={tab}
                onChange={setTab}
                options={[
                  { id: 'a', label: 'Overview' },
                  { id: 'b', label: 'Changes', count: 5 },
                  { id: 'c', label: 'Settings' },
                ]}
              />
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  ['list', 'List'],
                  ['grid', 'Grid'],
                ]}
              />
            </div>
          </Specimen>
        </Section>

        <Section
          id="overlays"
          title="Overlays"
          note="Dialogs for decisions, menus for lists of actions, tooltips for icon-only controls."
        >
          <Specimen label="Dialog, menu, callout">
            <Button onClick={() => setOpen(true)}>Open dialog</Button>
            <Dropdown align="start" trigger={<Button>Menu</Button>}>
              <MenuItem>Profile</MenuItem>
              <MenuItem>Settings</MenuItem>
              <MenuSeparator />
              <MenuItem>Sign out</MenuItem>
            </Dropdown>
            <Modal
              open={open}
              onClose={() => setOpen(false)}
              title="Connect CodeRabbit"
              description="Line-by-line review of each change, with a summary."
            >
              <Callout tone="info">
                It will be able to read code and comment on changes.
              </Callout>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button variant="brand" onClick={() => setOpen(false)}>
                  Connect
                </Button>
              </div>
            </Modal>
          </Specimen>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Callout tone="info" title="Info">
              Neutral guidance.
            </Callout>
            <Callout tone="success" title="Success">
              It worked.
            </Callout>
            <Callout tone="warning" title="Warning">
              Needs a look.
            </Callout>
          </div>
        </Section>

        <Section
          id="charts"
          title="Charts"
          note="SVG and HTML from the theme tokens: 2px lines on a soft brand wash, hairline grids, series colours in a fixed order. Trend, grouped bars and sparkline fill a parent with a height; share and ranked bars size to their content."
        >
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Specimen
              label="Trend"
              source="TrendChart"
              className="h-56 surface rounded-2xl border bg-card p-3"
            >
              <TrendChart
                data={sampleSeries}
                unit="Commits"
                className="h-full"
              />
            </Specimen>
            <Specimen
              label="Grouped bars"
              source="GroupedBars"
              className="h-56 surface rounded-2xl border bg-card p-3"
            >
              <GroupedBars
                data={['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((label, i) => ({
                  label,
                  commits: 20 + i * 7,
                  reviews: 10 + ((i * 5) % 12),
                }))}
                series={[
                  { key: 'commits', label: 'Commits' },
                  { key: 'reviews', label: 'Reviews' },
                ]}
              />
            </Specimen>
            <Specimen
              label="Share"
              source="ShareBar"
              className="surface rounded-2xl border bg-card p-4"
            >
              <ShareBar
                data={[
                  { name: 'Rust', value: 62 },
                  { name: 'TypeScript', value: 24 },
                  { name: 'Shell', value: 14 },
                ]}
              />
            </Specimen>
            <Specimen
              label="Ranked"
              source="RankedBars"
              className="surface rounded-2xl border bg-card p-4"
            >
              <RankedBars
                data={[
                  { label: 'Commits', value: 46 },
                  { label: 'Reviews', value: 28 },
                  { label: 'Changes', value: 16 },
                  { label: 'Issues', value: 9 },
                  { label: 'Releases', value: 5 },
                ]}
              />
            </Specimen>
          </div>
          <Specimen label="Sparkline, for dense rows" source="Sparkline">
            <div className="h-10 w-40">
              <Sparkline
                data={sampleSeries.map((p) => p.value)}
                label="Commits per week"
              />
            </div>
            <div className="h-10 w-40">
              <Sparkline
                data={sampleSeries.map((p) => 60 - p.value)}
                label="Open issues per week"
              />
            </div>
          </Specimen>
        </Section>

        <Section
          id="patterns"
          title="Patterns"
          note="Larger parts built from the pieces above. The same row shape shows up wherever a list of things appears."
        >
          <Specimen
            label="Software card"
            source="SoftwareCard"
            className="grid grid-cols-1 gap-4 rounded-2xl border bg-card p-5 sm:grid-cols-2"
          >
            {sampleRepos
              .filter((r) => r.releases.length > 0)
              .slice(0, 2)
              .map((r) => (
                <SoftwareCard key={r.name} repo={r} />
              ))}
          </Specimen>
          <Specimen
            label="Project row"
            source="RepoRow"
            className="overflow-hidden surface rounded-2xl border bg-card"
          >
            <div className="w-full divide-y">
              <RepoRow repo={sampleRepos[0]} showToday />
              <RepoRow repo={sampleRepos[1]} />
            </div>
          </Specimen>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <Specimen label="Project card" source="RepoCard" className="">
              <RepoCard repo={sampleRepos[2]} />
            </Specimen>
            <Specimen
              label="Person row"
              source="DeveloperRow"
              className="overflow-hidden surface rounded-2xl border bg-card"
            >
              <div className="w-full">
                <DeveloperRow
                  dev={{
                    object: 'person',
                    handle: sampleDeveloper.handle,
                    name: sampleDeveloper.name,
                    bio: sampleDeveloper.bio,
                    followers: sampleDeveloper.followers,
                    repositories: 4,
                    stars: 1200,
                    languages: sampleDeveloper.languages,
                    html_url: `/${sampleDeveloper.handle}`,
                    viewer_follows: false,
                  }}
                />
              </div>
            </Specimen>
          </div>
          <Specimen
            label="Row with a status and one action"
            className="overflow-hidden surface rounded-2xl border bg-card"
          >
            <ul className="w-full divide-y">
              {[
                ['CodeRabbit', 'coderabbit', true],
                ['Blacksmith', 'blacksmith', false],
              ].map(([name, id, connected]) => (
                <li key={String(id)} className="flex items-center gap-3 p-4">
                  <BrandTile id={id as BrandId} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {String(name)}
                      {connected && <Badge tone="success">Connected</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      One line that says what it does.
                    </p>
                  </div>
                  <Button size="sm">
                    {connected ? 'Disconnect' : 'Connect'}
                  </Button>
                </li>
              ))}
            </ul>
          </Specimen>
        </Section>
      </div>
    </div>
  )
}
