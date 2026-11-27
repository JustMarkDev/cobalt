import { createFileRoute } from '@tanstack/react-router'
import { serveGit } from '~/lib/api/git-route'

// One segment after `.git`, so without this static route the request would
// match the repository page (`$handle/$repo/$tab`) and never reach git.
export const Route = createFileRoute('/$handle/{$repo}.git/git-receive-pack')({
  server: { handlers: { POST: serveGit } },
})
