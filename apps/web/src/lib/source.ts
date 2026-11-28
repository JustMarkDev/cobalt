import { createElement } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowsLeftRightIcon,
  BookOpenIcon,
  BracketsCurlyIcon,
  CodeIcon,
  CpuIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  FolderIcon,
  GearSixIcon,
  GitMergeIcon,
  HardDriveIcon,
  KeyIcon,
  LightbulbIcon,
  LightningIcon,
  ListBulletsIcon,
  LockIcon,
  PlayIcon,
  PuzzlePieceIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TerminalWindowIcon,
  UsersIcon,
} from '@phosphor-icons/react'
import { defineDocs } from 'fumadocs-mdx/macro'
import { loader } from 'fumadocs-core/source'
import type { ComponentType, SVGProps } from 'react'

const icons: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  DownloadSimpleIcon,
  ArrowClockwiseIcon,
  ArrowsLeftRightIcon,
  LightningIcon,
  BookOpenIcon,
  CodeIcon,
  GearSixIcon,
  TerminalWindowIcon,
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  GitMergeIcon,
  KeyIcon,
  LightbulbIcon,
  ListBulletsIcon,
  LockIcon,
  PlayIcon,
  PuzzlePieceIcon,
  RocketLaunchIcon,
  HardDriveIcon,
  ShieldCheckIcon,
  SparkleIcon,
  UsersIcon,
  BracketsCurlyIcon,
}

export const docs = defineDocs({
  dir: 'content/docs',
  docs: { async: true },
})

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  icon(name) {
    const Icon = name
      ? (icons[name] as ComponentType<SVGProps<SVGSVGElement>> | undefined)
      : undefined
    return Icon ? createElement(Icon) : undefined
  },
})
