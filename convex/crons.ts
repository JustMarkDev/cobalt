import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'sweep api stores',
  { minutes: 10 },
  internal.apiStores.sweep,
  {},
)

crons.interval('sweep tokens', { hours: 1 }, internal.forge.tokens.sweep, {})
crons.interval(
  'requeue runner jobs',
  { minutes: 1 },
  internal.forge.pipelines.sweepLeases,
  {},
)
crons.interval('sweep oauth', { minutes: 15 }, internal.forge.oauth.sweep, {})
crons.interval('sweep mail', { hours: 6 }, internal.mail.sweep, {})
crons.interval('sweep audit log', { hours: 24 }, internal.forge.audit.sweep, {})
crons.interval(
  'sweep operations',
  { hours: 6 },
  internal.forge.operations.sweep,
  {},
)

crons.interval('sweep health', { minutes: 30 }, internal.forge.health.sweep, {})
crons.interval(
  'seed tallies',
  { minutes: 10 },
  internal.forge.health.startSeed,
  {},
)

crons.interval(
  'purge deleted accounts',
  { hours: 1 },
  internal.deletion.purgeDue,
  {},
)

crons.interval('send analytics', { minutes: 1 }, internal.analytics.send, {})

export default crons
