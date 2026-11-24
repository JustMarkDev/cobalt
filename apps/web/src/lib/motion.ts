import * as React from 'react'
import { animate } from 'motion/mini'

export const EASE = [0.22, 1, 0.36, 1] as const
export const DURATION = 0.2
export const STAGGER = 0.028
export const STAGGER_CAP = 10

let ready = false
export function markMotionReady() {
  ready = true
}

export function canAnimate(): boolean {
  return (
    ready &&
    typeof window !== 'undefined' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function enter(el: HTMLElement, rise = 6) {
  if (!canAnimate()) return
  void animate(
    el,
    { opacity: [0, 1], transform: [`translateY(${rise}px)`, 'none'] },
    { duration: DURATION, ease: EASE },
  ).then(() => {
    el.style.removeProperty('opacity')
    el.style.removeProperty('transform')
  })
}

export function useEnterOnChange<T extends HTMLElement>(trigger: unknown) {
  const last = React.useRef(trigger)
  return React.useCallback(
    (el: T | null) => {
      if (!el || last.current === trigger) return
      last.current = trigger
      enter(el)
    },
    [trigger],
  )
}

export function useStaggerIn<T extends HTMLElement>() {
  return React.useCallback((parent: T | null) => {
    if (!parent || !canAnimate()) return
    const items = Array.from(parent.children).slice(
      0,
      STAGGER_CAP,
    ) as Array<HTMLElement>
    if (items.length === 0) return
    items.forEach((el, i) => {
      void animate(
        el,
        { opacity: [0, 1], transform: ['translateY(8px)', 'none'] },
        { duration: DURATION + 0.04, ease: EASE, delay: i * STAGGER },
      ).then(() => {
        el.style.removeProperty('opacity')
        el.style.removeProperty('transform')
      })
    })
  }, [])
}
