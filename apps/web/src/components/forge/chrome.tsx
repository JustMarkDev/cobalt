import * as React from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowElbowDownLeftIcon,
  ArrowsLeftRightIcon,
  BookOpenIcon,
  CaretDownIcon,
  CheckIcon,
  GearSixIcon,
  GlobeIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PulseIcon,
  SignOutIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { cn } from 'cn'
import { useOpMaybe } from '~/lib/forge'
import { Kbd } from './bits'
import { AccountTile } from './organization'
import type { LinkProps } from '@tanstack/react-router'
import { siDiscord, siGithub, siX, siYoutube } from '~/components/social-icons'
import { Pill } from '~/components/motion'
import { Button } from '~/components/ui/button'
import { Dropdown, MenuItem, MenuSeparator } from '~/components/ui/menu'
import { switchAccount, useAccounts } from '~/lib/auth/accounts'
import { useTarget } from '~/lib/platform'
import { authClient } from '~/lib/auth/client'
import { SUPPORT_EMAIL, socials } from '~/lib/site'
import { BrandMark } from '~/components/brand-mark'
import { SETUP_PROMPT } from '~/lib/setup-prompt'

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={cn(
        '-my-2 inline-flex items-center gap-2.5 py-2 text-[17px] font-bold tracking-[-0.02em]',
        className,
      )}
    >
      <BrandMark className="h-6 w-5" />
      <span>cobalt</span>
    </Link>
  )
}

function UserMenu() {
  const navigate = useNavigate()
  const { me, accounts, active } = useAccounts()
  if (!me || !active) return null
  const org = active.kind === 'organization'
  return (
    <Dropdown
      className="w-64"
      trigger={
        <button
          type="button"
          aria-label={`${active.name}, account menu`}
          title={active.name}
          className={cn(
            'relative flex focus-ring',
            active.kind === 'person' ? 'rounded-full' : 'rounded-lg',
          )}
        >
          <AccountTile account={active} className="size-9 text-xs" />
        </button>
      }
    >
      <div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        Signed in as{' '}
        <span className="font-medium text-foreground">@{me.handle}</span>
      </div>
      {accounts.map((a) => (
        <MenuItem key={a.id} onClick={() => switchAccount(me, a.handle)}>
          <AccountTile account={a} className="size-5 text-[9px]" />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          {a.id === active.id ? (
            <CheckIcon className="text-foreground!" />
          ) : (
            a.kind === 'organization' && (
              <span className="text-xs text-muted-foreground">Org</span>
            )
          )}
        </MenuItem>
      ))}
      <MenuItem
        render={<Link to="/organizations/new" />}
        className="text-muted-foreground"
      >
        <PlusIcon /> New organization
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        render={
          org ? (
            <Link
              to="/organizations/$handle/$section"
              params={{ handle: active.handle, section: 'general' }}
            />
          ) : (
            <Link to="/settings/$section" params={{ section: 'profile' }} />
          )
        }
      >
        <GearSixIcon />
        <span className="flex-1">Settings</span>
        <span className="font-mono text-xs text-muted-foreground">G S</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        className="text-danger data-[highlighted]:bg-danger/10 [&_svg]:text-danger"
        onClick={() => {
          void navigate({ to: '/' }).then(() => authClient.signOut())
        }}
      >
        <SignOutIcon />
        Sign out
      </MenuItem>
    </Dropdown>
  )
}

const accountOnly = new Set([
  'dashboard',
  'inbox',
  'settings',
  'integrations',
  'accounts',
  'new',
])

type Command = {
  id: string
  label: string
  hint: string
  group: 'Projects' | 'People' | 'Go to' | 'Accounts'
  keys?: string
  run: () => void
}

function CommandPalette({
  open,
  onOpenChange,
  signedIn,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  signedIn: boolean
}) {
  const navigate = useNavigate()
  const { me, accounts, active: acting } = useAccounts()
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const repos = useOpMaybe('repos.list', { limit: 200 }, open)?.data ?? []
  const people = useOpMaybe('people.list', { limit: 200 }, open)?.data ?? []

  const commands = React.useMemo<Array<Command>>(
    () => [
      {
        id: 'dashboard',
        label: 'Dashboard',
        hint: 'Your inbox, your repositories and your numbers',
        group: 'Go to',
        keys: 'g d',
        run: () => void navigate({ to: '/dashboard' }),
      },
      {
        id: 'discover',
        label: 'Discover',
        hint: 'Find projects and people',
        group: 'Go to',
        keys: 'g e',
        run: () => void navigate({ to: '/discover' }),
      },
      {
        id: 'inbox',
        label: 'Inbox',
        hint: 'Reviews, mentions and releases',
        group: 'Go to',
        keys: 'g i',
        run: () => void navigate({ to: '/dashboard' }),
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Profile, linked accounts, integrations, agents',
        group: 'Go to',
        keys: 'g s',
        run: () =>
          void navigate({
            to: '/settings/$section',
            params: { section: 'profile' },
          }),
      },
      {
        id: 'integrations',
        label: 'Integrations',
        hint: 'Reviewers, runners, agent environments, secrets',
        group: 'Go to',
        run: () =>
          void navigate({
            to: '/settings/$section',
            params: { section: 'integrations' },
          }),
      },
      {
        id: 'accounts',
        label: 'Linked accounts',
        hint: 'Bring your history from another host',
        group: 'Go to',
        run: () =>
          void navigate({
            to: '/settings/$section',
            params: { section: 'accounts' },
          }),
      },
      {
        id: 'pricing',
        label: 'Pricing',
        hint: 'Plans for storage, history and teams',
        group: 'Go to',
        run: () => void navigate({ to: '/pricing' }),
      },
      {
        id: 'status',
        label: 'Status',
        hint: 'Is everything running?',
        group: 'Go to',
        run: () => void navigate({ to: '/status' }),
      },
      {
        id: 'docs',
        label: 'Docs',
        hint: 'Guides, CLI and configuration reference',
        group: 'Go to',
        run: () => void navigate({ to: '/docs/$', params: { _splat: '' } }),
      },
      {
        id: 'new',
        label: 'New repository',
        hint: 'Create or import',
        group: 'Go to',
        run: () => void navigate({ to: '/new' }),
      },
      ...repos.map<Command>((r) => ({
        id: `${r.owner}/${r.name}`,
        label: `${r.owner}/${r.name}`,
        hint: r.description,
        group: 'Projects',
        run: () =>
          void navigate({
            to: '/$handle/$repo/$tab',
            params: { handle: r.owner, repo: r.name, tab: 'code' },
          }),
      })),
      ...people.map<Command>((d) => ({
        id: `@${d.handle}`,
        label: d.name,
        hint: d.bio ? `@${d.handle} · ${d.bio}` : `@${d.handle}`,
        group: 'People',
        run: () =>
          void navigate({ to: '/$handle', params: { handle: d.handle } }),
      })),
    ],
    [navigate, repos, people],
  )

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const accountCommands: Array<Command> =
      me && acting
        ? [
            ...accounts
              .filter((a) => a.id !== acting.id)
              .map<Command>((a) => ({
                id: `switch:${a.id}`,
                label: `Switch to ${a.name}`,
                hint:
                  a.kind === 'organization'
                    ? 'Act as this organization'
                    : 'Act as yourself',
                group: 'Accounts',
                run: () => switchAccount(me, a.handle),
              })),
            {
              id: 'new-organization',
              label: 'New organization',
              hint: 'A company, team or project that owns repositories',
              group: 'Accounts',
              run: () => void navigate({ to: '/organizations/new' }),
            },
          ]
        : []
    const available = signedIn
      ? [...accountCommands, ...commands]
      : [
          {
            id: 'sign-in',
            label: 'Sign in',
            hint: 'Pick up where you left off',
            group: 'Go to' as const,
            run: () => void navigate({ to: '/sign-in' }),
          },
          {
            id: 'sign-up',
            label: 'Create an account',
            hint: 'Free to start. Bring your history with you',
            group: 'Go to' as const,
            run: () => void navigate({ to: '/sign-up' }),
          },
          ...commands.filter((c) => !accountOnly.has(c.id)),
        ]
    const list = q
      ? available.filter((c) =>
          `${c.label} ${c.hint}`.toLowerCase().includes(q),
        )
      : available.filter((c) => c.group === 'Go to' || c.group === 'Accounts')
    return list.slice(0, 8)
  }, [commands, query, signedIn, navigate, me, acting, accounts])

  const pick = (c: Command | undefined) => {
    if (!c) return
    onOpenChange(false)
    c.run()
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setQuery('')
          setActive(0)
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="overlay-backdrop fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          aria-label="Search"
          className="overlay-popup fixed top-[16vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover floating outline-none"
        >
          <div className="flex items-center gap-3 border-b px-4">
            <MagnifyingGlassIcon className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((a) => Math.min(a + 1, results.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((a) => Math.max(a - 1, 0))
                } else if (e.key === 'Enter') {
                  pick(results.at(active))
                }
              }}
              placeholder="Search projects, people and pages"
              aria-label="Search"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <Kbd>esc</Kbd>
          </div>
          <ul className="max-h-80 overflow-y-auto p-1.5">
            {results.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing found for "{query}".
              </li>
            )}
            {results.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(c)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[calc(var(--radius-2xl)-0.375rem-1px)] px-3 py-2 text-left text-sm',
                    i === active && 'bg-muted',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {c.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.hint}
                    </span>
                  </span>
                  {c.keys && !query && (
                    <span className="flex gap-1">
                      {c.keys.split(' ').map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  )}
                  {i === active && (
                    <ArrowElbowDownLeftIcon className="size-3.5 text-muted-foreground" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const publicLinks = [
  { label: 'Discover', to: '/discover' },
  { label: 'Pricing', to: '/pricing' },
] as const
const navLinks = [
  { label: 'Dashboard', to: '/dashboard' },
  ...publicLinks,
] as const

const navItem =
  'relative inline-flex h-9 shrink-0 items-center rounded-lg px-3.5 text-[14.5px] whitespace-nowrap text-muted-foreground focus-ring-inset transition-colors hover:bg-muted hover:text-foreground max-[359px]:px-2.5'
const navActive = 'font-medium text-foreground'

function NavItem({
  pill,
  label,
  count = 0,
  ...link
}: LinkProps & { pill: string; label: string; count?: number }) {
  return (
    <Link
      {...link}
      className={navItem}
      activeProps={{ className: navActive }}
      aria-label={count > 0 ? `${label}, ${count} unread` : undefined}
    >
      {({ isActive }) => (
        <>
          {isActive && <Pill id={pill} />}
          <span className="relative">{label}</span>
          {count > 0 && (
            <span className="relative ml-1.5 rounded-full bg-brand px-1.5 font-mono text-[11px] leading-4 text-brand-foreground tabular-nums">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </>
      )}
    </Link>
  )
}

const productLinks = [
  {
    icon: ArrowsLeftRightIcon,
    label: 'Import and mirrors',
    hint: 'From any host, in both directions',
    link: {
      to: '/docs/$',
      params: { _splat: 'getting-started/import-and-mirrors' },
    },
  },
  {
    icon: TerminalWindowIcon,
    label: 'Agents',
    hint: 'MCP and CLI, built in',
    link: { to: '/docs/$', params: { _splat: 'concepts/agents' } },
  },
  {
    icon: KeyIcon,
    label: 'Secrets',
    hint: 'Per person, per environment',
    link: { to: '/docs/$', params: { _splat: 'concepts/secrets' } },
  },
] as const

const resourceLinks = [
  {
    icon: BookOpenIcon,
    label: 'Documentation',
    link: { to: '/docs/$', params: { _splat: '' } },
  },
  { icon: GlobeIcon, label: 'Discover', link: { to: '/discover' } },
  { icon: PulseIcon, label: 'Status', link: { to: '/status' } },
] as const

function ProductMenu({
  id,
  onNavigate,
  focusFirst,
}: {
  id: string
  onNavigate: () => void
  focusFirst: boolean
}) {
  const [copied, setCopied] = React.useState(false)
  const panel = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (focusFirst) panel.current?.querySelector('a')?.focus()
  }, [focusFirst])
  return (
    <div
      ref={panel}
      id={id}
      className="floating absolute inset-x-0 top-16 border-y border-dashed bg-background"
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pt-6 pb-8 md:grid-cols-[1.25fr_0.8fr_1fr]">
        <div>
          <h2 className="mb-2 ml-2.5 text-[12.5px] font-medium text-muted-foreground">
            Platform
          </h2>
          {productLinks.map(({ icon: Icon, label, hint, link }) => (
            <Link
              key={label}
              {...link}
              onClick={onNavigate}
              className="flex gap-3.5 rounded-xl p-2.5 transition-colors hover:bg-muted"
            >
              <span className="raised flex size-9.5 shrink-0 items-center justify-center rounded-[11px] border bg-card">
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block text-[15px] font-semibold">{label}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {hint}
                </span>
              </span>
            </Link>
          ))}
        </div>
        <div>
          <h2 className="mb-2 ml-2.5 text-[12.5px] font-medium text-muted-foreground">
            Resources
          </h2>
          {resourceLinks.map(({ icon: Icon, label, link }) => (
            <Link
              key={label}
              {...link}
              onClick={onNavigate}
              className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-[15px] transition-colors hover:bg-muted"
            >
              <Icon className="size-4.5 text-muted-foreground" />
              {label}
            </Link>
          ))}
        </div>
        <div className="surface flex min-h-44 flex-col gap-3.5 rounded-2xl border bg-[radial-gradient(120%_120%_at_0%_0%,color-mix(in_oklch,var(--brand)_14%,transparent),transparent_70%)] p-5">
          <span className="mt-auto text-lg font-bold tracking-[-0.015em]">
            Set up in one prompt
          </span>
          <Button
            variant="brand"
            size="sm"
            className="self-start"
            onClick={() => {
              void navigator.clipboard
                .writeText(SETUP_PROMPT)
                .catch(() => undefined)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SiteHeader() {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const signedIn = session !== null
  const links = signedIn ? navLinks : publicLinks
  const desktopPill = React.useId()
  const mobilePill = React.useId()
  const productId = React.useId()
  const [productOpen, setProductOpen] = React.useState(false)
  const hoverOpenedAt = React.useRef(0)
  const openedByKeyboard = React.useRef(false)
  const productButton = React.useRef<HTMLButtonElement>(null)
  const pathname = useRouterState({ select: (st) => st.location.pathname })
  React.useEffect(() => setProductOpen(false), [pathname])
  const [scrolled, setScrolled] = React.useState(false)
  const headerRef = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  React.useEffect(() => {
    if (!productOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setProductOpen(false)
        productButton.current?.focus()
      }
    }
    const onClick = (e: MouseEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setProductOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [productOpen])
  const signedInRef = React.useRef(signedIn)
  signedInRef.current = signedIn
  React.useEffect(() => {
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.tagName === 'SELECT' ||
          e.target.isContentEditable)
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setProductOpen(false)
        setOpen(true)
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        setProductOpen(false)
        setOpen(true)
      } else if (pending) {
        pending = false
        clearTimeout(timer)
        if (e.key === 'h') void navigate({ to: '/' })
        if (e.key === 'e') void navigate({ to: '/discover' })
        if (!signedInRef.current) return
        if (e.key === 'd') void navigate({ to: '/dashboard' })
        if (e.key === 'i') void navigate({ to: '/dashboard' })
        if (e.key === 's')
          void navigate({
            to: '/settings/$section',
            params: { section: 'profile' },
          })
      } else if (e.key === 'g') {
        pending = true
        timer = setTimeout(() => (pending = false), 1200)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [navigate])
  const unread = useOpMaybe('notifications.count', {}, signedIn)?.unread ?? 0
  const { target } = useTarget()
  const searchButton = (
    <button
      type="button"
      onClick={() => {
        setProductOpen(false)
        setOpen(true)
      }}
      aria-label="Search"
      className="raised focus-ring inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <MagnifyingGlassIcon className="size-4" />
      <span className="hidden lg:inline">Search</span>
      <span className="hidden lg:inline">
        <Kbd>{target && target.os !== 'macos' ? 'Ctrl K' : '⌘K'}</Kbd>
      </span>
    </button>
  )

  return (
    <header
      ref={headerRef}
      data-scrolled={scrolled || undefined}
      data-open={productOpen || undefined}
      className="group/nav sticky top-0 z-40"
      onMouseLeave={() => setProductOpen(false)}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('a')) setProductOpen(false)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setProductOpen(false)
      }}
    >
      <div aria-hidden="true" className="progressive-blur">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="relative mx-auto grid h-16 max-w-6xl grid-cols-[1fr_auto] items-center gap-4 px-6 max-[359px]:gap-1 md:grid-cols-[1fr_auto_1fr]">
        <Logo className="justify-self-start" />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {!signedIn && (
            <button
              type="button"
              aria-expanded={productOpen}
              aria-controls={productId}
              ref={productButton}
              onClick={(e) => {
                openedByKeyboard.current = e.detail === 0
                setProductOpen(
                  (o) => !o || Date.now() - hoverOpenedAt.current < 400,
                )
              }}
              onMouseEnter={() => {
                openedByKeyboard.current = false
                if (!productOpen) hoverOpenedAt.current = Date.now()
                setProductOpen(true)
              }}
              className={cn(
                navItem,
                'gap-1.5',
                productOpen && 'bg-muted text-foreground',
              )}
            >
              Product
              <CaretDownIcon
                className={cn(
                  'size-3.5 transition-transform',
                  productOpen && 'rotate-180',
                )}
              />
            </button>
          )}
          {links.map((l) => (
            <NavItem
              key={l.to}
              pill={desktopPill}
              to={l.to}
              label={l.label}
              count={l.to === '/dashboard' ? unread : 0}
            />
          ))}
          <NavItem
            pill={desktopPill}
            to="/docs/$"
            params={{ _splat: '' }}
            label="Docs"
          />
        </nav>
        {session ? (
          <div className="flex items-center gap-1.5 justify-self-end">
            {searchButton}
            <Link
              to="/new"
              aria-label="New repository"
              className="raised focus-ring inline-flex size-9 items-center justify-center rounded-lg border bg-card text-foreground hover:bg-muted"
            >
              <PlusIcon className="size-4" />
            </Link>
            <span className="ml-1">
              <UserMenu />
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 justify-self-end max-[359px]:gap-1">
            {searchButton}
            <Button
              variant="ghost"
              className="hidden sm:inline-flex"
              render={<Link to="/sign-in" />}
              nativeButton={false}
            >
              Sign in
            </Button>
            <Button
              variant="brand"
              className="max-[359px]:px-2"
              render={<Link to="/sign-up" />}
              nativeButton={false}
            >
              Get started
            </Button>
          </div>
        )}
      </div>
      {!signedIn && productOpen && (
        <ProductMenu
          id={productId}
          onNavigate={() => setProductOpen(false)}
          focusFirst={openedByKeyboard.current}
        />
      )}
      <div className="relative mx-auto max-w-6xl px-6 pb-2 md:hidden">
        <nav aria-label="Main" className="trough flex h-11 w-fit max-w-full">
          <div className="trough-scroll">
            {links.map((l) => (
              <NavItem
                key={l.to}
                pill={mobilePill}
                to={l.to}
                label={l.label}
                count={l.to === '/dashboard' ? unread : 0}
              />
            ))}
            <NavItem
              pill={mobilePill}
              to="/docs/$"
              params={{ _splat: '' }}
              label="Docs"
            />
            {!signedIn && (
              <span className="contents sm:hidden">
                <NavItem pill={mobilePill} to="/sign-in" label="Sign in" />
              </span>
            )}
          </div>
        </nav>
      </div>
      <CommandPalette open={open} onOpenChange={setOpen} signedIn={signedIn} />
    </header>
  )
}

const socialIcons = {
  x: siX,
  discord: siDiscord,
  youtube: siYoutube,
  github: siGithub,
} as const

type FooterLink = { label: string; link: LinkProps | null; href?: string }

const footerColumns: Array<[string, Array<FooterLink>]> = [
  [
    'Product',
    [
      { label: 'Discover', link: { to: '/discover' } },
      { label: 'Compare', link: { to: '/', hash: 'compare' } },
      { label: 'Pricing', link: { to: '/pricing' } },
      { label: 'Dashboard', link: { to: '/dashboard' } },
    ],
  ],
  [
    'Build with it',
    [
      { label: 'Docs', link: { to: '/docs/$', params: { _splat: '' } } },
      { label: 'CLI', link: { to: '/docs/$', params: { _splat: 'cli' } } },
      {
        label: 'MCP server',
        link: { to: '/docs/$', params: { _splat: 'mcp' } },
      },
      { label: 'llms.txt', link: null },
    ],
  ],
  [
    'Company',
    [
      { label: 'Status', link: { to: '/status' } },
      { label: 'Support', link: null, href: `mailto:${SUPPORT_EMAIL}` },
      { label: 'Design system', link: { to: '/design' } },
      { label: 'Privacy', link: { to: '/privacy' } },
      { label: 'Terms', link: { to: '/terms' } },
    ],
  ],
]

export function SiteFooter() {
  const state = useOpMaybe('status.get', {})?.state
  const { data: session } = authClient.useSession()
  return (
    <footer className="relative mt-24 overflow-hidden border-t">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-10 px-6 pt-16 pb-12 text-[15px] sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="col-span-2 space-y-4 sm:col-span-1">
          <div className="pb-1">
            <Logo />
          </div>
          <p className="max-w-xs text-muted-foreground">
            Git hosting. Agent native.
          </p>
          <ul className="flex gap-2">
            {socials.map((s) => {
              const icon = socialIcons[s.id]
              return (
                <li key={s.id}>
                  <a
                    href={s.href}
                    aria-label={`${s.label} (opens in a new tab)`}
                    target="_blank"
                    rel="noreferrer"
                    className="raised focus-ring flex size-9 items-center justify-center rounded-lg border bg-card text-muted-foreground hover:text-foreground"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="size-4"
                      fill="currentColor"
                    >
                      <path d={icon.path} />
                    </svg>
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
        {footerColumns.map(([title, all]) => {
          const links = session
            ? all
            : all.filter(({ label }) => label !== 'Dashboard')
          return (
            <nav key={title} aria-label={title} className="space-y-2">
              <h2 className="text-[13px] font-medium text-muted-foreground">
                {title}
              </h2>
              <ul className="text-foreground/80">
                {links.map(({ label, link, href }) => (
                  <li key={label}>
                    {link ? (
                      <Link
                        {...link}
                        className="-mx-1 inline-block min-w-6 px-1 py-1 hover:text-foreground"
                      >
                        {label}
                      </Link>
                    ) : (
                      <a
                        href={href ?? '/llms.txt'}
                        className="inline-block py-1 hover:text-foreground"
                      >
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          )
        })}
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-6 py-6 text-[13px] text-muted-foreground">
        <span>
          © 2026 Marco Procopio. Names and logos belong to their owners; no
          endorsement implied.
        </span>
        <Link
          to="/status"
          className="-my-1 inline-flex items-center gap-1.5 py-1 hover:text-foreground"
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              state === 'down'
                ? 'bg-danger'
                : state === 'degraded'
                  ? 'bg-warning'
                  : 'bg-success',
            )}
          />
          {state === 'down'
            ? 'Something is down'
            : state === 'degraded'
              ? 'Some services are degraded'
              : 'All systems operational'}
        </Link>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none bg-linear-to-b from-foreground/[0.1] to-foreground/[0.035] bg-clip-text pt-[0.25em] pb-[0.2em] text-center text-[clamp(56px,17.5vw,250px)] leading-[0.8] font-extrabold tracking-[-0.045em] text-transparent select-none"
      >
        cobalt
      </div>
    </footer>
  )
}
