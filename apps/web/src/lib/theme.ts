import * as React from 'react'

const query = '(prefers-color-scheme: dark)'

export const themeInitScript = `(function(){try{document.documentElement.classList.toggle('dark',matchMedia('${query}').matches)}catch(e){}})()`

function subscribe(cb: () => void) {
  const mq = matchMedia(query)
  const onChange = () => {
    document.documentElement.classList.toggle('dark', mq.matches)
    cb()
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function useIsDark(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => true,
  )
}
