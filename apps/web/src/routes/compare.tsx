import { createFileRoute, redirect } from '@tanstack/react-router'

// The comparison is a section of the home page now. Old links land on it.
export const Route = createFileRoute('/compare')({
  beforeLoad: () => {
    throw redirect({ to: '/', hash: 'compare', statusCode: 301 })
  },
})
