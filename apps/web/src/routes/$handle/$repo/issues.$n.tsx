import { createFileRoute, redirect } from '@tanstack/react-router'

// The API's `html_url` for one issue: the page is the issues tab with `?n=`.
export const Route = createFileRoute('/$handle/$repo/issues/$n')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/$handle/$repo/$tab',
      params: { handle: params.handle, repo: params.repo, tab: 'issues' },
      search: { n: Number(params.n) },
      statusCode: 301,
    })
  },
})
