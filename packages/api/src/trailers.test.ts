import { describe, expect, test } from 'bun:test'
import { declaredModelOf, pushReceipt } from './trailers'

describe('a pushed commit declares its model in a trailer', () => {
  test('Assisted-by, with or without the agent before the colon', () => {
    expect(
      declaredModelOf('Fix it\n\nAssisted-by: claude-code:Claude Opus 5.5\n'),
    ).toBe('Claude Opus 5.5')
    expect(declaredModelOf('Fix it\n\nAssisted-by: GPT-6 Sol')).toBe(
      'GPT-6 Sol',
    )
  })

  test('a co-author with a model vendor no-reply address', () => {
    expect(
      declaredModelOf(
        'Fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      ),
    ).toBe('Claude Opus 5.5')
  })

  test('a person as co-author is never taken for a model', () => {
    expect(
      declaredModelOf('Fix it\n\nCo-Authored-By: Hollis Reyes <hollis@x.dev>'),
    ).toBeNull()
  })

  test('a label that is not plain text is dropped, not stored', () => {
    expect(declaredModelOf('Fix\n\nAssisted-by: <script>x</script>')).toBeNull()
  })

  test('the receipt names git push as the tool', () => {
    expect(pushReceipt(undefined)).toEqual({
      machine: null,
      tool: 'git push',
      model: null,
    })
  })
})
