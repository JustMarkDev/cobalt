import * as React from 'react'
import { Tile } from './bits'
import { useOpMaybe, useWrite } from '~/lib/forge'
import { useMe } from '~/lib/auth/accounts'

type At = { owner: string; repo: string; number: string }
type Kind = 'change' | 'issue'

export type Viewer = {
  actor: { handle: string }
  path: string | null
}

const tab =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `web-${crypto.randomUUID().slice(0, 13)}`
    : `web-${Math.random().toString(36).slice(2, 15)}`

export function usePresence(
  kind: Kind,
  at: At,
  path: string | null,
  enabled = true,
): Array<Viewer> {
  const write = useWrite()
  const op = kind === 'change' ? 'changes.presence' : 'issues.presence'
  const input = kind === 'change' ? at : { ...at, number: Number(at.number) }
  const listed = useOpMaybe(
    `${op}.get` as 'changes.presence.get',
    input as At,
    enabled,
  )
  const interval = (listed?.interval ?? 20) * 1000
  const where = React.useRef(path)
  const key = `${at.owner}/${at.repo}/${kind}/${at.number}`
  React.useEffect(() => {
    where.current = path
    if (!enabled) return
    void write(`${op}.put` as 'changes.presence.put', {
      ...(input as At),
      body: { session: tab, path, leave: false },
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `at`
  }, [path, key, enabled])
  React.useEffect(() => {
    if (!enabled) return
    const beat = () => {
      if (document.visibilityState === 'hidden') return
      void write(`${op}.put` as 'changes.presence.put', {
        ...(input as At),
        body: { session: tab, path: where.current, leave: false },
      })
    }
    const timer = window.setInterval(beat, interval)
    document.addEventListener('visibilitychange', beat)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
      void write(`${op}.put` as 'changes.presence.put', {
        ...(input as At),
        body: { session: tab, path: null, leave: true },
      })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `at`
  }, [key, interval, enabled])
  if (!enabled) return []
  return listed?.viewers ?? []
}

export function Viewers({ viewers }: { viewers: Array<Viewer> }) {
  const me = useMe()
  const others = viewers.filter((v) => v.actor.handle !== me?.handle)
  if (!others.length) return null
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-label="Also looking"
    >
      <div className="flex -space-x-1.5">
        {others.slice(0, 6).map((v) => (
          <Face key={v.actor.handle} v={v} />
        ))}
      </div>
      <span>
        {others.length === 1
          ? `${others[0].actor.handle} is here`
          : `${others.length} others here`}
      </span>
    </div>
  )
}

function Face({ v, small }: { v: Viewer; small?: boolean }) {
  const title = `${v.actor.handle}${v.path ? ` on ${v.path}` : ''}`
  return (
    <span title={title} className="rounded-full ring-2 ring-background">
      <Tile
        name={v.actor.handle}
        round
        className={small ? 'size-4 text-[9px]' : 'size-6 text-xs'}
      />
    </span>
  )
}

export function FileViewers({
  viewers,
  path,
}: {
  viewers: Array<Viewer>
  path: string
}) {
  const me = useMe()
  const here = viewers.filter(
    (v) => v.path === path && v.actor.handle !== me?.handle,
  )
  if (!here.length) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex -space-x-1">
        {here.map((v) => (
          <Face key={v.actor.handle} v={v} small />
        ))}
      </span>
      {here.length === 1
        ? `${here[0].actor.handle} is on this file`
        : `${here.length} others on this file`}
    </span>
  )
}

export function useFileInView(enabled: boolean): string | null {
  const store = React.useMemo(() => (enabled ? fileInView() : null), [enabled])
  return React.useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.get ?? noFile,
    noFile,
  )
}

const noSubscribe = () => () => {}
const noFile = () => null

function fileInView() {
  let file: string | null = null
  return {
    get: () => file,
    subscribe: (changed: () => void) => {
      const seen = new Map<Element, IntersectionObserverEntry>()
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) seen.set(e.target, e)
          const top = [...seen.values()]
            .filter((e) => e.isIntersecting)
            .sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)
            .at(0)
          const next = top?.target.getAttribute('data-presence-file') ?? null
          if (next === file) return
          file = next
          changed()
        },
        { rootMargin: '-80px 0px -40% 0px' },
      )
      const watch = () =>
        document
          .querySelectorAll('[data-presence-file]')
          .forEach((el) => io.observe(el))
      watch()
      const mo = new MutationObserver(watch)
      mo.observe(document.body, { childList: true, subtree: true })
      return () => {
        io.disconnect()
        mo.disconnect()
      }
    },
  }
}
