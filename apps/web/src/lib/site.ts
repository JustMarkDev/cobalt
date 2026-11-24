export const socials = [
  { id: 'x', label: 'X', href: 'https://x.com' },
  { id: 'discord', label: 'Discord', href: 'https://discord.com' },
  { id: 'youtube', label: 'YouTube', href: 'https://youtube.com' },
  { id: 'github', label: 'GitHub', href: 'https://github.com' },
] as const

export type SocialId = (typeof socials)[number]['id']
