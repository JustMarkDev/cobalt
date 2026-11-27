import { createFileRoute, redirect } from '@tanstack/react-router'

// The API's `html_url` for one change: the page is the changes tab with `?n=`.
export const Route = createFileRoute('/$handle/$repo/changes/$n')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/$handle/$repo/$tab',
      params: { handle: params.handle, repo: params.repo, tab: 'changes' },
      search: { n: Number(params.n) },
      statusCode: 301,
    })
  },
})
