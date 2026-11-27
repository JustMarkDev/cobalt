import { expect, test } from 'bun:test'
import {
  groupAuthors,
  isBot,
  loginOfEmail,
  loginsOf,
  mergeByHandle,
} from './contributors'

const at = (d: number) => `2026-11-${String(d).padStart(2, '0')}T00:00:00.000Z`

// The authors of a real imported repository, as the API listed them before.
const history = [
  ...Array.from({ length: 3 }, (_, i) => ({
    name: 'Mark',
    email: '83364815+JustMarkDev@users.noreply.github.com',
    date: at(20 + i),
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    name: 'JustMarkDev',
    email: 'marco@example.com',
    date: at(10 + i),
  })),
  {
    name: 'semantic-release-bot',
    email: 'semantic-release-bot@martynus.net',
    date: at(25),
  },
  {
    name: 'dependabot[bot]',
    email: '49699333+dependabot[bot]@users.noreply.github.com',
    date: at(25),
  },
  {
    name: 'github-actions[bot]',
    email: '41898282+github-actions[bot]@users.noreply.github.com',
    date: at(24),
  },
  { name: 'Dana Okafor', email: 'dana@example.com', date: at(1) },
]

test('one person behind a no-reply address and a login-named commit', () => {
  const people = groupAuthors(history)
  expect(people.map((p) => [p.name, p.email, p.commits, p.last])).toEqual([
    ['Mark', 'marco@example.com', 5, at(22)],
    ['Dana Okafor', 'dana@example.com', 1, at(1)],
  ])
  expect(people[0].logins).toEqual(['JustMarkDev'])
})

test('bots are not contributors', () => {
  expect(isBot({ name: 'semantic-release-bot', email: 'x@y.z' })).toBe(true)
  expect(isBot({ name: 'renovate', email: 'bot@renovateapp.com' })).toBe(true)
  expect(isBot({ name: 'GitHub', email: 'noreply@github.com' })).toBe(true)
  expect(isBot({ name: 'Abbot Smith', email: 'abbot@example.com' })).toBe(false)
  expect(
    loginOfEmail('49699333+dependabot[bot]@users.noreply.github.com'),
  ).toBe(null)
  expect(loginOfEmail('JustMarkDev@users.noreply.github.com')).toBe(
    'JustMarkDev',
  )
})

test('groups that are one account merge under its handle', () => {
  const people = groupAuthors([
    {
      name: 'Mark',
      email: '1+JustMarkDev@users.noreply.github.com',
      date: at(3),
    },
    { name: 'Marco Procopio', email: 'work@example.com', date: at(2) },
    { name: 'Marco Procopio', email: 'work@example.com', date: at(1) },
  ])
  expect(people).toHaveLength(2)
  const handles: Record<string, string> = { justmarkdev: 'mark' }
  const merged = mergeByHandle(people, (g) => {
    for (const l of loginsOf(g)) if (handles[l.toLowerCase()]) return 'mark'
    return g.email === 'work@example.com' ? 'mark' : null
  })
  expect(merged).toEqual([
    {
      name: 'Marco Procopio',
      email: 'work@example.com',
      commits: 3,
      last: at(3),
      logins: ['JustMarkDev'],
      handle: 'mark',
    },
  ])
})
