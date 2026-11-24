import type { Command } from './types'

export const mcp: Command = async () => {
  const { serveStdio } = await import('../mcp-stdio')
  await serveStdio()
}
