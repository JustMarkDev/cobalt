import { expect, test } from 'bun:test'
import { acceptedOf, commandsOf } from './receive'
import { concat, pkt } from './transfer'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const Z = '0'.repeat(40)
const flush = new TextEncoder().encode('0000')

test('the ref updates come before the pack', () => {
  const head = concat([
    pkt(`${Z} ${A} refs/heads/main\0 report-status side-band-64k\n`),
    pkt(`${A} ${B} refs/heads/dev\n`),
    flush,
    new TextEncoder().encode('PACK....'),
  ])
  expect(commandsOf(head)).toEqual([
    { before: Z, after: A, ref: 'refs/heads/main' },
    { before: A, after: B, ref: 'refs/heads/dev' },
  ])
  // Cut before the flush: not enough yet.
  expect(commandsOf(head.subarray(0, 30))).toBeNull()
})

test('what the server took, with and without side-band', () => {
  const report = concat([
    pkt('unpack ok\n'),
    pkt('ok refs/heads/main\n'),
    pkt('ng refs/heads/dev non-fast-forward\n'),
    flush,
  ])
  expect([...acceptedOf(report)!]).toEqual(['refs/heads/main'])
  const band = (n: number, b: Uint8Array) => {
    const body = concat([new Uint8Array([n]), b])
    return concat([
      new TextEncoder().encode((body.length + 4).toString(16).padStart(4, '0')),
      body,
    ])
  }
  const banded = concat([
    band(2, new TextEncoder().encode('remote: hello\n')),
    band(1, report),
    flush,
  ])
  expect([...acceptedOf(banded)!]).toEqual(['refs/heads/main'])
  expect(acceptedOf(concat([pkt('unpack index-pack failed\n'), flush]))).toBe(
    null,
  )
})
