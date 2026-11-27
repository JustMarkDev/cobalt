import { createFileRoute } from '@tanstack/react-router'
import { serveGit } from '~/lib/api/git-route'

export const Route = createFileRoute('/$handle/{$repo}.git/$')({
  server: { handlers: { GET: serveGit, POST: serveGit } },
})
