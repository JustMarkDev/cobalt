import { cn } from 'cn'
import {
  siBitbucket,
  siClaude,
  siCloudflare,
  siCodeberg,
  siCoderabbit,
  siCursor,
  siForgejo,
  siGitea,
  siGithub,
  siGitlab,
  siLinear,
  siQodo,
  siSentry,
  siVercel,
} from './brand-icons'
import type * as React from 'react'
import type { BrandIcon } from './brand-icons'

type Brand =
  | { name: string; icon: BrandIcon }
  | { name: string; file: string; invert?: boolean; edge?: boolean }

export const brands = {
  github: { name: 'GitHub', icon: siGithub },
  gitlab: { name: 'GitLab', icon: siGitlab },
  gitea: { name: 'Gitea', icon: siGitea },
  forgejo: { name: 'Forgejo', icon: siForgejo },
  codeberg: { name: 'Codeberg', icon: siCodeberg },
  bitbucket: { name: 'Bitbucket', icon: siBitbucket },
  coderabbit: { name: 'CodeRabbit', icon: siCoderabbit },
  greptile: { name: 'Greptile', file: 'greptile.png', edge: true },
  macroscope: { name: 'Macroscope', file: 'macroscope.svg', edge: true },
  qodo: { name: 'Qodo', icon: siQodo },
  bugbot: { name: 'Cursor Bugbot', icon: siCursor },
  claudereview: { name: 'Claude Code Review', icon: siClaude },
  blacksmith: { name: 'Blacksmith', file: 'blacksmith.svg', edge: true },
  namespace: { name: 'Namespace', file: 'namespace.svg', invert: true },
  depot: { name: 'Depot', file: 'depot.png', invert: true },
  warpbuild: { name: 'WarpBuild', file: 'warpbuild.png', edge: true },
  t3code: { name: 'T3 Code', file: 't3code.png', edge: true },
  boat: { name: 'boat.dev', file: 'boat.svg', invert: true },
  e2b: { name: 'E2B', file: 'e2b.png', edge: true },
  daytona: { name: 'Daytona', file: 'daytona.png', edge: true },
  vercel: { name: 'Vercel Sandbox', icon: siVercel },
  cloudflare: { name: 'Cloudflare Sandbox', icon: siCloudflare },
  varlock: { name: 'Varlock', file: 'varlock.png', invert: true },
  linear: { name: 'Linear', icon: siLinear },
  sentry: { name: 'Sentry', icon: siSentry },
} as const satisfies Record<string, Brand>

export type BrandId = keyof typeof brands

function channel(c: number) {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

type Rgb = [number, number, number]

const rgb = (hex: string) =>
  [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb

const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

const LIGHT_CARD = 0.98
const DARK_CARD = 0.012

export function readableOn(hex: string, surface: number, min: number) {
  let c = rgb(hex)
  const toward = surface > 0.5 ? 0 : 255
  for (let i = 0; i < 30 && contrast(luminance(c), surface) < min; i++)
    c = c.map((v) => Math.round(v + (toward - v) * 0.1)) as Rgb
  return `rgb(${c.join(' ')})`
}

export function BrandLogo({
  id,
  className,
}: {
  id: BrandId
  className?: string
}) {
  const brand: Brand = brands[id]
  if ('file' in brand) {
    return (
      <img
        src={`/logos/${brand.file}`}
        alt=""
        loading="lazy"
        className={cn(
          'size-5 rounded-xs object-contain',
          brand.invert && 'dark:hue-rotate-180 dark:invert',
          brand.edge && 'ring-1 ring-black/10 dark:ring-white/15',
          className,
        )}
      />
    )
  }
  const { icon } = brand
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      className={cn(
        'size-5 fill-current text-(--mark-light) dark:text-(--mark-dark)',
        className,
      )}
      style={
        {
          '--mark-light': readableOn(icon.hex, LIGHT_CARD, 4),
          '--mark-dark': readableOn(icon.hex, DARK_CARD, 4.5),
        } as React.CSSProperties
      }
    >
      <path d={icon.path} />
    </svg>
  )
}

export function BrandTile({
  id,
  className,
}: {
  id: BrandId
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card',
        className,
      )}
    >
      <BrandLogo id={id} />
    </span>
  )
}

export function brandName(id: BrandId) {
  return brands[id].name
}
