import { forgejoCreate } from './01-create'
import { forgejoPull } from './02-pull'
import { forgejoPush } from './03-push'
import { forgejoTokens } from './04-tokens'
import { forgejoWebhooks } from './05-webhooks'
import type { Scenario } from '../lib'

export { stopForgejo } from './env'

export const forgejoScenarios: Array<Scenario> = [
  forgejoCreate,
  forgejoPull,
  forgejoPush,
  forgejoTokens,
  forgejoWebhooks,
]
