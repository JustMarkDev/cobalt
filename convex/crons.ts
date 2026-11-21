import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// Rate-limit windows and idempotency keys are only useful for a while.
crons.interval(
  'sweep api stores',
  { minutes: 10 },
  internal.apiStores.sweep,
  {},
)

// Tokens past expiry, OAuth state that ran out, operations long over.
crons.interval('sweep tokens', { hours: 1 }, internal.forge.tokens.sweep, {})
crons.interval('sweep oauth', { minutes: 15 }, internal.forge.oauth.sweep, {})
crons.interval(
  'sweep operations',
  { hours: 6 },
  internal.forge.operations.sweep,
  {},
)

// The status page: health minutes and days past keeping.
crons.interval('sweep health', { minutes: 30 }, internal.forge.health.sweep, {})
// Fills the tallies in once on a deployment that had rows before them; after
// that, one document read each time.
crons.interval(
  'seed tallies',
  { minutes: 10 },
  internal.forge.health.startSeed,
  {},
)

// Accounts whose 30 days after asking to be deleted are over are erased.
crons.interval(
  'purge deleted accounts',
  { hours: 1 },
  internal.deletion.purgeDue,
  {},
)

// Product events to PostHog, in batches. Does nothing without POSTHOG_KEY.
crons.interval('send analytics', { minutes: 1 }, internal.analytics.send, {})

export default crons
