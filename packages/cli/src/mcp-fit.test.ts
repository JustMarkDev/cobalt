import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  MCP_BUDGET,
  advertiseCompact,
  compactJsonSchema,
  fitText,
  noteContextLimits,
  pageTimeline,
} from './mcp-fit'

const timeline = (n: number, size = 10) =>
  JSON.stringify({
    id: '216',
    entries: Array.from({ length: n }, (_, i) => ({
      i,
      summary: 'x'.repeat(size),
    })),
  })
type Page = {
  total: number
  from: number
  entries: Array<{ i: number }>
  earlier: { count: number; hint: string } | null
}

describe('pageTimeline', () => {
  test('the newest entries, oldest first, and how to read further back', () => {
    const p = JSON.parse(pageTimeline(timeline(120))) as Page
    expect(p.total).toBe(120)
    expect(p.entries.map((e) => e.i)).toEqual(
      Array.from({ length: 50 }, (_, i) => 70 + i),
    )
    expect(p.earlier?.count).toBe(70)
    expect(p.earlier?.hint).toContain('before: 70')
  })

  test('before walks back to the start', () => {
    const p = JSON.parse(
      pageTimeline(timeline(120), { before: 70, limit: 50 }),
    ) as Page
    expect(p.entries[0].i).toBe(20)
    expect(p.entries.at(-1)?.i).toBe(69)
    const first = JSON.parse(
      pageTimeline(timeline(120), { before: 20 }),
    ) as Page
    expect(first.entries.map((e) => e.i)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    )
    expect(first.earlier).toBeNull()
  })

  test('a short timeline comes whole', () => {
    const p = JSON.parse(pageTimeline(timeline(3))) as Page
    expect(p.entries).toHaveLength(3)
    expect(p.earlier).toBeNull()
  })

  test('large entries are dropped from the old end to fit the budget', () => {
    const out = pageTimeline(timeline(50, 2_000))
    const p = JSON.parse(out) as Page
    expect(out.length).toBeLessThanOrEqual(MCP_BUDGET)
    expect(p.entries.at(-1)?.i).toBe(49)
    expect(p.earlier?.count).toBe(p.from)
    expect(p.from).toBeGreaterThan(0)
  })

  test('one entry over the budget keeps the page and its cursor', () => {
    const p = JSON.parse(pageTimeline(timeline(2, 40_000))) as Page & {
      cut: string
    }
    expect(p.from).toBe(1)
    expect(p.entries).toEqual([])
    expect(p.earlier?.count).toBe(1)
    expect(p.cut).toContain('position 1')
  })

  test('positions do not move when entries are added', () => {
    const first = JSON.parse(pageTimeline(timeline(120))) as Page
    const later = JSON.parse(
      pageTimeline(timeline(130), { before: first.from }),
    ) as Page
    // New entries go at the end; the page before position 70 is the same.
    expect(later.entries.at(-1)?.i).toBe(first.from - 1)
  })
})

describe('fitText', () => {
  test('leaves an answer within budget alone, but without indentation', () => {
    const t = JSON.stringify({ a: [1, 2, 3], b: 'x y' })
    expect(fitText(t)).toBe(t)
    expect(fitText(JSON.stringify({ a: [1, 2, 3], b: 'x y' }, null, 2))).toBe(t)
    expect(fitText('plain text, not JSON')).toBe('plain text, not JSON')
  })

  test('shortens the longest list and says how many were left out', () => {
    const big = JSON.stringify({
      repo: 'dana/gitfs',
      items: Array.from({ length: 1000 }, (_, i) => ({ i, t: 'y'.repeat(60) })),
    })
    const out = fitText(big)
    expect(out.length).toBeLessThanOrEqual(MCP_BUDGET)
    const v = JSON.parse(out) as {
      repo: string
      items: Array<unknown>
      items_omitted: string
    }
    expect(v.repo).toBe('dana/gitfs')
    expect(v.items.length).toBeGreaterThan(10)
    expect(v.items_omitted).toContain(`of 1000 left out`)
  })

  test('a top-level list is wrapped with a note', () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => i * 1e9))
    const v = JSON.parse(fitText(big)) as {
      data: Array<number>
      omitted: string
    }
    expect(v.data[0]).toBe(0)
    expect(v.omitted).toContain('of 5000')
  })

  test('an answer whose bulk is one long text stays in budget', () => {
    const one = JSON.stringify({ id: 'cmt_1', body: 'b'.repeat(50_000) })
    const two = JSON.stringify([
      { id: 'a', body: 'x'.repeat(40_000) },
      { id: 'b', body: 'y'.repeat(40_000) },
    ])
    for (const text of [one, two]) {
      const out = fitText(text)
      expect(out.length).toBeLessThanOrEqual(MCP_BUDGET)
      expect(out).toContain('[cut: ')
      expect(() => JSON.parse(out) as unknown).not.toThrow()
    }
    expect((JSON.parse(fitText(one)) as { id: string }).id).toBe('cmt_1')
  })

  test('text that is not JSON is cut with a note', () => {
    const out = fitText('z'.repeat(50_000))
    expect(out.length).toBeLessThanOrEqual(MCP_BUDGET)
    expect(out).toContain('cut')
  })
})

describe('noteContextLimits', () => {
  test('says when the lists are full and where the rest is', () => {
    const full = JSON.stringify({
      openChanges: Array.from({ length: 50 }, (_, i) => ({ number: i })),
      openIssues: [{ number: 1 }],
    })
    const c = JSON.parse(noteContextLimits(full)) as { more: Array<string> }
    expect(c.more).toHaveLength(1)
    expect(c.more[0]).toContain('list_changes')
    const small = JSON.stringify({ openChanges: [], openIssues: [] })
    expect(noteContextLimits(small)).toBe(small)
  })
})

describe('compact schemas', () => {
  test('drop $schema and the safe-integer bounds, keep real bounds', () => {
    const s = compactJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        n: {
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991,
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    })
    expect(s).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    })
  })

  test('what is advertised is compact; what is accepted is unchanged', async () => {
    const schema = advertiseCompact(z.object({ n: z.number().int() }))
    const std = schema['~standard'] as unknown as {
      jsonSchema: { input: (o: unknown) => unknown }
      validate: (v: unknown) => Promise<{ issues?: unknown }>
    }
    expect(std.jsonSchema.input({ target: 'draft-2020-12' })).toEqual({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    })
    expect((await std.validate({ n: 2 })).issues).toBeUndefined()
    expect((await std.validate({ n: 2.5 })).issues).toBeDefined()
    expect(schema.parse({ n: 3 })).toEqual({ n: 3 })
  })
})
