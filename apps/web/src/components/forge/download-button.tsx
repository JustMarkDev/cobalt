import { Menu } from '@base-ui/react/menu'
import {
  ArrowDownTrayIcon,
  CheckIcon,
  ChevronDownIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import type { Platform, Release } from '~/lib/model/data'
import {
  archLabel,
  availableOses,
  matchAsset,
  osLabel,
  useTarget,
} from '~/lib/platform'

const OSES: Array<Platform> = ['macos', 'windows', 'linux']

/**
 * One button for the file that fits the machine you are on, plus a menu with
 * every other build. The choice is detected, never asked for.
 */
export function DownloadButton({
  release,
  size = 'md',
  className,
  onDownload,
}: {
  release: Release
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /** Called with the file when someone downloads it, to count it. */
  onDownload?: (file: string) => void
}) {
  const { target, isOverridden, setTarget } = useTarget()
  const { asset: best, fit } = matchAsset(release, target)
  const oses = availableOses(release)
  const height = { sm: 'h-7 text-xs', md: 'h-9 text-sm', lg: 'h-11 text-base' }[
    size
  ]
  const none = fit === 'none' && target
  const label = none
    ? `No ${osLabel[target.os]} build`
    : target && size !== 'sm'
      ? `Download for ${osLabel[target.os]}`
      : 'Download'
  const hint = none
    ? size === 'sm'
      ? ''
      : `Only ${oses.map((o) => osLabel[o]).join(', ')}`
    : fit === 'os' && best
      ? `${best.arch === 'arm64' ? 'ARM64' : 'x64'} build only`
      : target
        ? size === 'sm'
          ? osLabel[target.os]
          : size === 'lg'
            ? archLabel(target)
            : release.version
        : release.version
  const why = none
    ? `${release.version} has no ${osLabel[target.os]} build. It is available for ${oses.map((o) => osLabel[o]).join(' and ')}.`
    : fit === 'os' && target && best
      ? `No ${archLabel(target)} build. This one is for ${best.arch}.`
      : best?.file

  return (
    <div
      className={cn(
        'inline-flex rounded-lg',
        // One keycap: the face and its shadow belong to the whole button, so
        // pressing either half presses both.
        !none && 'raised bg-brand text-brand-foreground',
        className,
      )}
    >
      {none ? (
        <span
          title={why}
          aria-disabled="true"
          className={cn(
            'inline-flex cursor-not-allowed items-center gap-2 rounded-l-lg border bg-muted px-3 font-medium whitespace-nowrap text-muted-foreground',
            height,
          )}
        >
          <NoSymbolIcon className={size === 'lg' ? 'size-5' : 'size-4'} />
          {label}
          {hint && (
            <span
              className={cn(
                'text-xs font-normal opacity-80',
                size !== 'sm' && 'max-sm:hidden',
              )}
            >
              {hint}
            </span>
          )}
        </span>
      ) : (
        <a
          href="#download"
          onClick={(e) => {
            e.preventDefault()
            if (best) onDownload?.(best.file)
          }}
          title={why}
          className={cn(
            // Focus is drawn inside each half, so it never crosses the divider.
            'inline-flex items-center gap-2 rounded-l-lg px-3 font-semibold whitespace-nowrap transition-colors hover:bg-white/15 focus-ring-inset [--focus-color:var(--brand-foreground)]',
            height,
          )}
        >
          <ArrowDownTrayIcon className={size === 'lg' ? 'size-5' : 'size-4'} />
          {label}
          <span
            className={cn(
              'font-mono text-xs font-normal opacity-70',
              size !== 'sm' && 'max-sm:hidden',
            )}
          >
            {hint}
          </span>
        </a>
      )}
      <Menu.Root>
        <Menu.Trigger
          aria-label="Other downloads"
          className={cn(
            'inline-flex items-center rounded-r-lg px-1.5 transition-colors',
            // One divider between the halves: the left half draws it when it
            // has a border of its own, the trigger draws it otherwise.
            none
              ? 'border-y border-r bg-muted text-muted-foreground focus-ring-inset hover:bg-foreground/5 active:bg-foreground/10'
              : 'border-l border-brand-foreground/20 hover:bg-white/15 focus-ring-inset [--focus-color:var(--brand-foreground)]',
            height,
          )}
        >
          <ChevronDownIcon className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={6} className="z-50">
            <Menu.Popup className="overlay-popup w-80 rounded-xl border bg-popover p-1 text-sm floating outline-none">
              <div className="px-2 pt-2 pb-1.5 text-xs text-muted-foreground">
                {target ? (
                  <>
                    {isOverridden ? 'Chosen' : 'Detected'}:{' '}
                    <span className="font-medium text-foreground">
                      {osLabel[target.os]}, {archLabel(target)}
                    </span>
                  </>
                ) : (
                  'Pick a build'
                )}
              </div>
              {OSES.map((os) => {
                const list = release.assets.filter((a) => a.platform === os)
                if (!list.length) return null
                const first = list.at(0)
                return (
                  <div key={os}>
                    <div className="flex items-center justify-between px-2 pt-2 pb-1 font-mono text-xs tracking-wider text-muted-foreground uppercase">
                      {osLabel[os]}
                      {target?.os !== os && (
                        <Menu.Item
                          onClick={() =>
                            setTarget({
                              os,
                              arch: first?.arch === 'arm64' ? 'arm64' : 'x64',
                            })
                          }
                          className="cursor-default rounded-lg px-1.5 normal-case outline-none data-[highlighted]:bg-muted"
                        >
                          use for me
                        </Menu.Item>
                      )}
                    </div>
                    {list.map((a) => (
                      <Menu.Item
                        key={a.file}
                        className="flex cursor-default items-center justify-between gap-3 rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-muted"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-xs">
                            {a.file}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {a.arch}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          {a === best && (
                            <CheckIcon className="size-3.5 text-success" />
                          )}
                          {a.size}
                        </span>
                      </Menu.Item>
                    ))}
                  </div>
                )
              })}
              <div className="mt-1 border-t px-2 py-1.5 text-xs text-muted-foreground">
                Every file is checksummed. Details are on the release page.
              </div>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )
}

/** Shows what we detected and lets the visitor correct it. */
export function TargetPicker({ className }: { className?: string }) {
  const { target, isOverridden, setTarget } = useTarget()
  if (!target)
    return (
      <div
        aria-hidden
        className={cn('flex flex-wrap items-center gap-2 text-xs', className)}
      >
        <span className="text-muted-foreground">We detected</span>
        <div className="trough h-8 w-48" />
        <div className="raised h-8 w-24 rounded-lg border bg-card" />
      </div>
    )
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-xs', className)}>
      <span className="text-muted-foreground">
        {isOverridden ? 'Showing builds for' : 'We detected'}
      </span>
      <div className="trough flex h-8">
        {OSES.map((os) => (
          <button
            key={os}
            type="button"
            aria-pressed={target.os === os}
            onClick={() =>
              setTarget({ os, arch: os === 'macos' ? 'arm64' : 'x64' })
            }
            className={cn(
              'inline-flex items-center justify-center rounded-(--radius-thumb) px-2.5 whitespace-nowrap focus-ring-inset text-muted-foreground transition-colors hover:text-foreground',
              target.os === os && 'thumb font-medium text-foreground',
            )}
          >
            {osLabel[os]}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setTarget({
            os: target.os,
            arch: target.arch === 'arm64' ? 'x64' : 'arm64',
          })
        }
        className="raised inline-flex h-8 min-w-24 items-center justify-center rounded-lg border bg-card px-2.5 text-muted-foreground hover:text-foreground"
        title="Switch CPU architecture"
      >
        {archLabel(target)}
      </button>
      {isOverridden && (
        <button
          type="button"
          onClick={() => setTarget(null)}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Reset to detected
        </button>
      )}
    </div>
  )
}
