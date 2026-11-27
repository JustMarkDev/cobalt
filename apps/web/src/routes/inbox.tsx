import { createFileRoute, redirect } from '@tanstack/react-router'

/** The inbox lives on the dashboard now. Old links land there. */
export const Route = createFileRoute('/inbox')({
  beforeLoad: () => {
    throw redirect({
      to: '/dashboard',
      search: { box: 'unread' },
      replace: true,
    })
  },
})
