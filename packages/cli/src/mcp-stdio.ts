import { serveStdio as serve } from '@modelcontextprotocol/server/stdio'
import { createSxMcpServer } from './mcp'

export function serveStdio() {
  serve(() => createSxMcpServer())
  return Promise.resolve()
}
