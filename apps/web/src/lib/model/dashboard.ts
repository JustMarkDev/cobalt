import type { LinkProps } from '@tanstack/react-router'
import type { Repo, Source } from './data'

export type Severity = 'stopped' | 'failing' | 'review' | 'assigned'

export type NeedsItem = {
  severity: Severity
  title: string
  where: string
  note: string
  age: string
  action: string
  link: LinkProps
}

export type InProgress = {
  kind: 'agent' | 'change'
  title: string
  where: string
  status: string
  tone: 'info' | 'muted' | 'warning'
  detail: string
  link: LinkProps
}

export type ActivityKind = 'review' | 'release' | 'agent' | 'other'

export type Activity = {
  who: string
  did: string
  what: string
  where?: string
  when: string
  day: 'Today' | 'Yesterday' | 'Earlier this week'
  kind: ActivityKind
  model?: string
}

export type Health = {
  checks: 'passing' | 'failing'
  openChanges: number
  openIssues: number
  updated: string
}

export type Mirror = {
  host: Extract<Source, 'github' | 'gitlab' | 'codeberg'>
  name: string
  state: 'synced' | 'stopped'
  note: string
}

type Series = { daily: Array<number>; total: number; change: number }

export type DashboardData = {
  empty: boolean
  needsYou: Array<NeedsItem>
  inProgress: Array<InProgress>
  activity: Array<Activity>
  repos: Array<Repo>
  health: Record<string, Health | undefined>
  mirrors: Array<Mirror>
  storage: { usedGb: number; limitGb: number }
  imported: number
  downloads: Series
  contributions: Omit<Series, 'daily'> & {
    daily: Array<{ label: string; value: number }>
    commits: number
    reviews: number
    changes: number
  }
  stars: { total: number; today: number }
}
