import * as React from 'react'
import { useRouterState } from '@tanstack/react-router'
import { LazyMotion, MotionConfig } from 'motion/react'
import * as m from 'motion/react-m'
import { animate } from 'motion/mini'
import {
  EASE,
  canAnimate,
  markMotionReady,
  useEnterOnChange,
  useStaggerIn,
} from '~/lib/motion'

const loadFeatures = () =>
  import('./motion-features').then((mod) => mod.default)

export function MotionProvider({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    markMotionReady()
  }, [])
  return (
    <LazyMotion features={loadFeatures}>
      <MotionConfig
        reducedMotion="user"
        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  )
}

export function PageTransition({
  trigger,
  className,
  children,
}: {
  trigger: unknown
  className?: string
  children: React.ReactNode
}) {
  const ref = useEnterOnChange<HTMLDivElement>(trigger)
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

export function Stagger({
  as: Tag = 'div',
  className,
  children,
}: {
  as?: 'div' | 'ul' | 'ol' | 'section'
  className?: string
  children: React.ReactNode
}) {
  const ref = useStaggerIn<HTMLElement>()
  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  )
}

function readThumbRadius(): number {
  if (typeof document === 'undefined') return 8
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--radius-thumb')
    .trim()
  return /^\d+(\.\d+)?px$/.test(raw) ? parseFloat(raw) : 8
}

export function Pill({ id }: { id: string }) {
  const [radius] = React.useState(readThumbRadius)
  return (
    <m.span
      layoutId={id}
      aria-hidden
      transition={{ type: 'spring', stiffness: 600, damping: 42 }}
      style={{ borderRadius: radius }}
      className="thumb absolute inset-0"
    />
  )
}

export function RouteProgress() {
  const pending = useRouterState({ select: (s) => s.status === 'pending' })
  const bar = React.useRef<HTMLDivElement>(null)
  const shown = React.useRef(false)

  React.useEffect(() => {
    const el = bar.current
    if (!el) return
    if (pending) {
      const t = setTimeout(() => {
        if (!canAnimate()) return
        shown.current = true
        el.style.opacity = '1'
        void animate(
          el,
          { transform: ['scaleX(0)', 'scaleX(0.85)'] },
          { duration: 6, ease: EASE },
        )
      }, 150)
      return () => clearTimeout(t)
    }
    if (shown.current) {
      shown.current = false
      void animate(
        el,
        { transform: 'scaleX(1)', opacity: 0 },
        { duration: 0.25, ease: EASE },
      )
    }
  }, [pending])

  return (
    <div
      ref={bar}
      aria-hidden
      className="pointer-events-none fixed top-0 right-0 left-0 z-50 h-0.5 origin-left bg-brand opacity-0"
      style={{ transform: 'scaleX(0)' }}
    />
  )
}
