import * as React from 'react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import {
  CheckIcon,
  ClipboardDocumentIcon,
  LinkIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline'
import { cn } from 'cn'
import { LicenseView } from './license-view'
import type { Components, Options } from 'react-markdown'
import type { ReactNode } from 'react'
import type { Repo } from '~/lib/model/data'
import { Button } from '~/components/ui/button'
import { useOpMaybe } from '~/lib/forge'
import { StateTabs } from '~/components/ui/tabs'
import { Dropdown, MenuItem } from '~/components/ui/menu'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const textOf = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : React.isValidElement<{ children?: ReactNode }>(node)
        ? textOf(node.props.children)
        : ''

// READMEs and imported issues are often written in HTML (`<p align="center">`,
// `<img width>`, `<details>`, `<picture>` for dark-mode logos). Parse it and
// keep what GitHub keeps; everything else (scripts, styles, event handlers) is
// stripped. `rehype-raw` must run before `rehype-sanitize`.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    source: [...(defaultSchema.attributes?.source ?? []), 'media', 'type'],
  },
}
const rehypePlugins: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, schema],
]

type Align = 'left' | 'center' | 'right' | 'justify'
const alignOf = (props: object): Align | undefined => {
  const a = (props as { align?: unknown }).align
  return a === 'left' || a === 'center' || a === 'right' || a === 'justify'
    ? a
    : undefined
}

function Heading({
  level,
  align,
  children,
}: {
  level: 1 | 2 | 3 | 4
  align?: Align
  children?: ReactNode
}) {
  const id = slug(textOf(children))
  const size =
    level === 1
      ? 'mt-0 text-3xl font-semibold tracking-tight'
      : level === 2
        ? 'mt-10 border-b pb-2 text-xl font-semibold tracking-tight'
        : level === 3
          ? 'mt-7 text-base font-semibold'
          : 'mt-6 text-sm font-semibold'
  const Tag = (['h2', 'h3', 'h4', 'h5'] as const)[level - 1]
  return (
    <Tag
      id={id}
      style={align ? { textAlign: align } : undefined}
      className={cn('group scroll-mt-header', size)}
    >
      {children}
      {level > 1 && (
        <a
          href={`#${id}`}
          aria-label="Link to this section"
          className="ml-1 inline-flex size-6 items-center justify-center align-middle text-muted-foreground/0 transition-colors group-hover:text-muted-foreground focus-visible:text-muted-foreground"
        >
          <LinkIcon className="size-4" />
        </a>
      )}
    </Tag>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="well my-5 overflow-hidden rounded-xl border bg-muted/50">
      <div className="flex items-center justify-between border-b px-3.5 py-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="inline-flex items-center gap-1 rounded-[calc(var(--radius-xl)-0.375rem-1px)] px-2 py-1 focus-ring-inset hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <ClipboardDocumentIcon className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        tabIndex={0}
        className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed focus-ring-inset"
      >
        {code}
      </pre>
    </div>
  )
}

const components: Components = {
  h1: ({ children, ...p }) => (
    <Heading level={1} align={alignOf(p)}>
      {children}
    </Heading>
  ),
  h2: ({ children, ...p }) => (
    <Heading level={2} align={alignOf(p)}>
      {children}
    </Heading>
  ),
  h3: ({ children, ...p }) => (
    <Heading level={3} align={alignOf(p)}>
      {children}
    </Heading>
  ),
  h4: ({ children, ...p }) => (
    <Heading level={4} align={alignOf(p)}>
      {children}
    </Heading>
  ),
  p: ({ children, ...p }) => (
    <p
      style={alignOf(p) ? { textAlign: alignOf(p) } : undefined}
      className="my-4 leading-[1.75] text-foreground/85"
    >
      {children}
    </p>
  ),
  div: ({ children, ...p }) => (
    <div style={alignOf(p) ? { textAlign: alignOf(p) } : undefined}>
      {children}
    </div>
  ),
  img: ({ src, alt, width, height }) => (
    <img
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      width={width}
      height={height}
      loading="lazy"
      className="inline-block h-auto max-w-full align-middle"
    />
  ),
  details: ({ children }) => (
    <details className="my-4 rounded-xl border px-4 py-2 [&[open]>summary]:mb-2">
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer font-medium">{children}</summary>
  ),
  kbd: ({ children }) => (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
      {children}
    </kbd>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      rel="nofollow ugc noopener"
      className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        'my-4 space-y-1.5 pl-6 leading-[1.7] marker:text-muted-foreground',
        className?.includes('contains-task-list')
          ? 'list-none pl-1'
          : 'list-disc',
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-1.5 pl-6 leading-[1.7] marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-label={checked ? 'Done' : 'Not done'}
      className="pointer-events-none mr-2 size-4 translate-y-0.5"
    />
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-5 border-l-2 pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-8" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  table: ({ children }) => (
    <div
      tabIndex={0}
      className="my-5 overflow-x-auto rounded-xl border bg-card"
    >
      <table className="w-full border-collapse text-left text-[14px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b px-4 py-2.5 align-top [tr:last-child>&]:border-0">
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const code = textOf(children).replace(/\n$/, '')
    const lang = /language-(\w+)/.exec(className ?? '')?.[1]
    if (lang || textOf(children).endsWith('\n'))
      return <CodeBlock lang={lang ?? ''} code={code} />
    return (
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.88em]">
        {children}
      </code>
    )
  },
}

export function headingsOf(
  source: string,
): Array<{ id: string; text: string; level: number }> {
  let fenced = false
  const out: Array<{ id: string; text: string; level: number }> = []
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    const m = !fenced && /^(#{2,3})\s+(.+)$/.exec(line)
    if (m) out.push({ id: slug(m[2]), text: m[2], level: m[1].length })
  }
  return out
}

export function MarkdownBody({
  source,
  className,
  compact = false,
}: {
  source: string
  className?: string
  /** Smaller type and no outer margins, for issue and comment bodies. */
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        compact
          ? 'text-sm [&>:first-child]:mt-0 [&>:last-child]:mb-0'
          : 'text-[15.5px]',
        'break-words',
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  )
}

export type RepoDoc = 'readme' | 'contributing' | 'license'

const DOC_FILES: Record<RepoDoc, string> = {
  readme: 'README.md',
  contributing: 'CONTRIBUTING.md',
  license: 'LICENSE',
}

export function ReadmeCard({
  repo,
  doc,
  onDoc,
}: {
  repo: Repo
  doc: RepoDoc
  onDoc: (doc: RepoDoc) => void
}) {
  const file = useOpMaybe('git.blob', {
    owner: repo.owner,
    repo: repo.name,
    path: DOC_FILES[doc],
  })
  const source = file?.encoding === 'utf-8' ? file.content : ''
  const outline = React.useMemo(() => headingsOf(source), [source])
  return (
    <section className="surface rounded-2xl border bg-card px-6 py-6 sm:px-9">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <StateTabs
          label="Documents"
          value={doc}
          onChange={onDoc}
          options={[
            { id: 'readme', label: 'README' },
            { id: 'contributing', label: 'Contributing' },
            { id: 'license', label: 'License' },
          ]}
        />
        {outline.length > 0 && (
          <Dropdown
            trigger={
              <Button variant="ghost">
                <ListBulletIcon /> Outline
              </Button>
            }
          >
            {outline.map((h) => (
              <MenuItem
                key={h.id}
                render={<a href={`#${h.id}`} />}
                className={h.level === 3 ? 'pl-6' : undefined}
              >
                {h.text}
              </MenuItem>
            ))}
          </Dropdown>
        )}
      </div>
      {doc === 'license' ? (
        <LicenseView id={repo.license} text={source} />
      ) : file === null ? (
        <p className="text-sm text-muted-foreground">
          This repository has no {DOC_FILES[doc]}.
        </p>
      ) : (
        <MarkdownBody source={source} />
      )}
    </section>
  )
}
