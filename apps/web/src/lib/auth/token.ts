import { createServerFn } from '@tanstack/react-start'

export const convexToken = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { convexTokenNow } = await import('./server')
    return await convexTokenNow()
  },
)
