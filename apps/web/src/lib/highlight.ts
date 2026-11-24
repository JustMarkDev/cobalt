import * as React from 'react'
import { preloadHighlighter } from '@pierre/diffs'

export const codeTheme = (dark: boolean) =>
  dark ? ('github-dark' as const) : ('github-light' as const)

const phone = '(max-width: 640px)'

export function useCodeOverflow(): 'scroll' | 'wrap' {
  return React.useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(phone)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => (matchMedia(phone).matches ? 'wrap' : 'scroll'),
    () => 'scroll',
  )
}

if (typeof window !== 'undefined') {
  void preloadHighlighter({
    themes: [codeTheme(false), codeTheme(true)],
    langs: ['rust', 'typescript', 'markdown', 'yaml', 'shellscript', 'dotenv'],
  }).catch(() => undefined)
}
