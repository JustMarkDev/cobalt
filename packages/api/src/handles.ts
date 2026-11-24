export const isValidHandle = (handle: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(handle)

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'support',
  'api',
  'docs',
  'design',
  'discover',
  'dashboard',
  'inbox',
  'new',
  'pricing',
  'status',
  'settings',
  'organizations',
  'privacy',
  'terms',
  'welcome',
  'sign-in',
  'sign-up',
  'forgot-password',
  'compare',
  'mcp',
  'llms',
  'about',
  'help',
  'login',
  'logout',
])

const ADJECTIVES = [
  'quiet',
  'bright',
  'brave',
  'calm',
  'clever',
  'eager',
  'gentle',
  'happy',
  'keen',
  'lucky',
  'mellow',
  'nimble',
  'proud',
  'swift',
  'warm',
  'witty',
]
const NOUNS = [
  'otter',
  'heron',
  'maple',
  'comet',
  'harbor',
  'lantern',
  'meadow',
  'pebble',
  'falcon',
  'willow',
  'ember',
  'summit',
  'river',
  'badger',
  'cedar',
  'orchid',
]

export function randomHandle(
  pick: (below: number) => number = (below) =>
    Math.floor(Math.random() * below),
): string {
  return `${ADJECTIVES[pick(ADJECTIVES.length)]}-${NOUNS[pick(NOUNS.length)]}-${100 + pick(900)}`
}
