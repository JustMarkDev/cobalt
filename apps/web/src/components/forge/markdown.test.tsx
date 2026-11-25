import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownBody } from './markdown'

const render = (source: string) =>
  renderToStaticMarkup(<MarkdownBody source={source} />)

describe('MarkdownBody', () => {
  test('renders the HTML that READMEs and imported issues use', () => {
    const out = render(
      '<p align="center"><img src="https://x.test/logo.png" width="120"></p>\n\n<details><summary>More</summary>\n\nhidden **bold**\n\n</details>',
    )
    expect(out).not.toContain('&lt;p')
    expect(out).toContain('text-align:center')
    expect(out).toContain('width="120"')
    expect(out).toContain('<summary')
    expect(out).toContain('<strong')
  })

  test('strips scripts, handlers and javascript: links', () => {
    const out = render(
      '<img src="https://x.test/a.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><iframe src="https://x.test"></iframe>',
    )
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('<iframe')
  })
})
