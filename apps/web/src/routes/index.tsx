import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import type { BrandIcon } from '~/components/brand-icons'
import {
  siBitbucket,
  siClaude,
  siCodeberg,
  siCursor,
  siForgejo,
  siGitea,
  siGithub,
  siGitlab,
} from '~/components/brand-icons'
import { siCodex, siGooglegemini, siOpencode } from '~/components/agent-icons'
import { BrandMark } from '~/components/brand-mark'
import { CompareTable, Legend } from '~/components/forge/compare-table'
import { Button } from '~/components/ui/button'
import { authClient } from '~/lib/auth/client'
import { SETUP_PROMPT } from '~/lib/setup-prompt'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: 'source.code: Git hosting. Agent native.' }],
  }),
  component: Landing,
})

const hosts: Array<BrandIcon> = [
  siGithub,
  siGitlab,
  siBitbucket,
  siGitea,
  siCodeberg,
  siForgejo,
]

const agents: Array<{ name: string; icon: BrandIcon }> = [
  { name: 'Claude Code', icon: siClaude },
  { name: 'Codex', icon: siCodex },
  { name: 'Gemini CLI', icon: siGooglegemini },
  { name: 'Cursor', icon: siCursor },
  { name: 'OpenCode', icon: siOpencode },
]

function Mark({ icon, className }: { icon: BrandIcon; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn('fill-current', className)}
    >
      <path d={icon.path} />
    </svg>
  )
}

/**
 * A statement whose words light up as they pass the middle of the screen.
 * With reduced motion, or before it hydrates, every word is lit.
 */
function Lit({
  as: Tag = 'h2',
  children,
  className,
}: {
  as?: 'h2' | 'p'
  children: string
  className?: string
}) {
  const ref = React.useRef<HTMLElement>(null)
  const [lit, setLit] = React.useState<number | null>(null)
  const words = children.split(' ')
  React.useEffect(() => {
    const el = ref.current
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const spans = [...el.querySelectorAll('span')]
    const paint = () => {
      const mid = window.innerHeight * 0.66
      setLit(spans.filter((s) => s.getBoundingClientRect().top < mid).length)
    }
    paint()
    window.addEventListener('scroll', paint, { passive: true })
    window.addEventListener('resize', paint)
    return () => {
      window.removeEventListener('scroll', paint)
      window.removeEventListener('resize', paint)
    }
  }, [])
  return (
    <Tag ref={ref as never} className={className} aria-label={children}>
      {words.map((w, i) => (
        <React.Fragment key={i}>
          {i > 0 && ' '}
          <span
            aria-hidden="true"
            className={cn(
              'transition-colors duration-500',
              lit !== null && i >= lit && 'text-muted-foreground',
            )}
          >
            {w}
          </span>
        </React.Fragment>
      ))}
    </Tag>
  )
}

function CopyPrompt({
  variant,
  className,
  children,
}: {
  variant: 'brand' | 'outline'
  className?: string
  children: string
}) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      variant={variant}
      size="lg"
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(SETUP_PROMPT).catch(() => undefined)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? 'Copied' : children}
    </Button>
  )
}

/**
 * The prompt with its commands set as code. A command keeps the punctuation
 * that follows it on its own line, so a comma never floats away from the chip;
 * below 360px a long command may wrap rather than be cut off.
 */
function PromptText() {
  const parts = SETUP_PROMPT.split(/(`[^`]+`)/)
  return (
    <p className="font-mono text-[13.5px] leading-[1.8] text-foreground/80 sm:text-[15px]">
      {parts.map((part, i) => {
        if (!part.startsWith('`')) {
          return i > 0 && parts[i - 1].startsWith('`')
            ? part.replace(/^[,.;:]/, '')
            : part
        }
        const tail = /^[,.;:]/.exec(parts[i + 1] ?? '')?.[0] ?? ''
        return (
          <span
            key={i}
            className="whitespace-nowrap max-[359px]:whitespace-normal"
          >
            <code className="rounded-md bg-muted px-1.5 py-0.5 text-foreground shadow-[inset_0_1px_0_var(--edge)] [box-decoration-break:clone]">
              {part.slice(1, -1)}
            </code>
            {tail}
          </span>
        )
      })}
    </p>
  )
}

const statement =
  'mx-auto max-w-[17ch] text-[clamp(40px,5.6vw,80px)] leading-[0.98] font-extrabold tracking-[-0.022em] text-balance'
const heading =
  'text-[clamp(48px,7vw,104px)] leading-[0.98] font-extrabold tracking-[-0.022em] text-balance'

function Landing() {
  const { data: session } = authClient.useSession()
  return (
    <div className="overflow-x-clip">
      <section className="relative flex min-h-[min(760px,calc(100svh-4rem))] items-center pt-6 pb-12">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-6 px-6 md:grid-cols-[1.35fr_0.65fr]">
          <div>
            <h1 className="text-[clamp(52px,8.6vw,132px)] leading-[0.93] font-extrabold tracking-[-0.03em] max-[359px]:text-[44px] md:whitespace-nowrap">
              Git hosting.
              <br />
              Agent native.
            </h1>
            <div className="mt-11 flex flex-wrap gap-3">
              <Button
                variant="brand"
                size="lg"
                render={<Link to={session ? '/new' : '/sign-up'} />}
                nativeButton={false}
              >
                {session ? 'Start a repository' : 'Start for free'}
              </Button>
              <CopyPrompt variant="outline">Copy setup prompt</CopyPrompt>
            </div>
          </div>
          <div className="relative order-first grid h-72 place-items-center md:order-none md:h-[min(440px,36vw)]">
            <div
              aria-hidden="true"
              className="absolute inset-[-10%] bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--brand)_18%,transparent),transparent_72%)]"
            />
            <div
              aria-hidden="true"
              className="absolute right-[18%] bottom-[4%] left-[18%] h-7 rounded-[50%] bg-black/25 blur-lg dark:bg-black/60"
            />
            <BrandMark className="relative h-[92%] w-auto -rotate-12 drop-shadow-[0_24px_24px_rgba(0,0,0,0.22)] dark:drop-shadow-[0_40px_40px_rgba(0,0,0,0.55)]" />
          </div>
        </div>
      </section>

      <section className="py-36 text-center">
        <div className="mx-auto max-w-6xl px-6">
          <p className="text-[clamp(88px,30vw,260px)] leading-[0.85] font-extrabold tracking-[-0.045em]">
            99.99
            <span className="text-[0.32em] tracking-[-0.02em] text-brand-ink">
              %
            </span>
          </p>
          <Lit className={cn(statement, 'mt-11')}>
            Your agent never sleeps. Neither does your code host.
          </Lit>
        </div>
      </section>

      <section id="import" className="scroll-mt-header py-36 text-center">
        <h2 className={cn(heading, 'px-6')}>Bring everything.</h2>
        <div className="my-18 overflow-hidden mask-x-from-88% mask-x-to-100%">
          {/* Each item carries its own trailing margin, so the two copies are
              exactly half the strip and the loop has no jump. */}
          <ul
            aria-label="Import from GitHub, GitLab, Bitbucket, Gitea, Codeberg and Forgejo"
            className="flex w-max animate-[marquee_36s_linear_infinite] motion-reduce:animate-none"
          >
            {[...hosts, ...hosts].map((h, i) => (
              <li
                key={i}
                aria-hidden={i >= hosts.length || undefined}
                className="surface mr-3.5 flex h-20 items-center gap-3.5 rounded-3xl border bg-card pr-8 pl-6 sm:h-21"
              >
                <Mark icon={h} className="size-7" />
                <span className="text-[22px] font-bold tracking-[-0.02em] sm:text-[28px]">
                  {h.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mx-auto max-w-6xl px-6">
          <Lit
            as="p"
            className="mx-auto max-w-[22ch] text-[clamp(30px,3.8vw,56px)] leading-[1.02] font-extrabold tracking-[-0.02em] text-balance"
          >
            Repositories. History. Issues. Reviews. Releases.
          </Lit>
          <h2 className={cn(heading, 'mt-30')}>Leave anytime.</h2>
        </div>
      </section>

      <section id="agents" className="scroll-mt-header py-36 text-center">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className={heading}>Any agent.</h2>
          {/* A centred wrap on phones; from sm up one row of five, so the
              cards never break four and one. */}
          <ul className="mt-16 flex flex-wrap justify-center gap-3.5 sm:mx-auto sm:grid sm:max-w-[57rem] sm:grid-cols-5">
            {agents.map((a) => (
              <li
                key={a.name}
                className="surface flex size-30 flex-col items-center justify-center gap-3.5 rounded-3xl border bg-card sm:aspect-square sm:size-auto sm:w-full"
              >
                <Mark icon={a.icon} className="size-9 sm:size-11" />
                <span className="text-[13px] font-semibold text-foreground/85 sm:text-[14.5px]">
                  {a.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="setup" className="scroll-mt-header py-36 text-center">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className={heading}>
            One prompt.
            <br />
            Your agent does the rest.
          </h2>
          <div className="surface mx-auto mt-14 flex max-w-[820px] flex-col gap-5 rounded-3xl border bg-card p-6 text-left sm:p-8 sm:pb-6">
            <PromptText />
            <div className="flex justify-end">
              <CopyPrompt variant="brand" className="w-full sm:w-auto">
                Copy prompt
              </CopyPrompt>
            </div>
          </div>
        </div>
      </section>

      <section id="secrets" className="scroll-mt-header py-36 text-center">
        <div className="mx-auto max-w-6xl px-6">
          <Lit className={statement}>Commit your secrets. Ship on day one.</Lit>
        </div>
      </section>

      <section
        aria-labelledby="compare"
        className="mx-auto max-w-6xl space-y-6 px-6 pt-36 pb-12"
      >
        <h2
          id="compare"
          className={cn(heading, 'scroll-mt-header pb-10 text-center')}
        >
          How it compares.
        </h2>
        <CompareTable />
        <div className="flex justify-center">
          <Legend />
        </div>
      </section>
    </div>
  )
}
