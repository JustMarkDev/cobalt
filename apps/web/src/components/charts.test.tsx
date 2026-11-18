import { describe, expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import {
  GroupedBars,
  RankedBars,
  ShareBar,
  Sparkline,
  TrendChart,
} from './charts'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ')

describe('charts render on the server', () => {
  test('trend: a line, ticks, labels at the ends and a table of every point', () => {
    const data = Array.from({ length: 12 }, (_, i) => ({
      label: `W${i + 1}`,
      value: 10 + i,
    }))
    const html = renderToString(<TrendChart data={data} unit="Commits" />)
    expect(html).toContain('<path')
    expect(html).toContain('non-scaling-stroke')
    // Every point is in the hidden table; only a few are labelled on the axis.
    expect(html.match(/<tr>/g)?.length).toBe(13)
    expect(text(html)).toContain('W1')
    expect(text(html)).toContain('W12')
    expect(html).toContain('Latest 21')
  })

  test('trend without axes draws no grid', () => {
    const grid = 'border-t border-border'
    const data = [{ label: 'a', value: 1 }]
    expect(renderToString(<TrendChart data={data} />)).toContain(grid)
    expect(
      renderToString(<TrendChart data={data} axes={false} />),
    ).not.toContain(grid)
  })

  test('trend with nothing to show says so', () => {
    expect(text(renderToString(<TrendChart data={[]} />))).toContain(
      'Nothing yet',
    )
  })

  test('grouped bars: a legend per series, series colours in order', () => {
    const html = renderToString(
      <GroupedBars
        data={[
          { label: 'Mon', commits: 3, reviews: 1 },
          { label: 'Tue', commits: 5, reviews: 2 },
        ]}
        series={[
          { key: 'commits', label: 'Commits' },
          { key: 'reviews', label: 'Reviews' },
        ]}
      />,
    )
    expect(text(html)).toContain('Commits')
    expect(text(html)).toContain('Reviews')
    expect(html.indexOf('var(--chart-1)')).toBeLessThan(
      html.indexOf('var(--chart-2)'),
    )
  })

  test('share: largest first, as percentages, the rest folded into Other', () => {
    const html = renderToString(
      <ShareBar
        data={[
          { name: 'Shell', value: 5 },
          { name: 'Rust', value: 60 },
          { name: 'Go', value: 10 },
          { name: 'TypeScript', value: 20 },
          { name: 'Nix', value: 5 },
        ]}
      />,
    )
    const t = text(html)
    expect(t.indexOf('Rust')).toBeLessThan(t.indexOf('TypeScript'))
    expect(t).toContain('60%')
    expect(t).toContain('Other')
    expect(t).not.toContain('Nix')
    expect(html).toContain('var(--chart-5)')
  })

  test('share drops empty parts and shows nothing for an empty whole', () => {
    expect(
      text(
        renderToString(
          <ShareBar
            data={[
              { name: 'People', value: 3 },
              { name: 'Bots', value: 0 },
            ]}
          />,
        ),
      ),
    ).not.toContain('Bots')
    expect(
      text(renderToString(<ShareBar data={[{ name: 'x', value: 0 }]} />)),
    ).toContain('Nothing yet')
  })

  test('ranked bars: largest first with the value printed', () => {
    const t = text(
      renderToString(
        <RankedBars
          data={[
            { label: 'Issues', value: 9 },
            { label: 'Commits', value: 46 },
          ]}
        />,
      ),
    )
    expect(t.indexOf('Commits')).toBeLessThan(t.indexOf('Issues'))
    expect(t).toContain('46')
  })

  test('sparkline names itself for screen readers', () => {
    const html = renderToString(
      <Sparkline data={[1, 4, 2, 8]} label="Downloads per day" />,
    )
    expect(html).toContain('aria-label="Downloads per day: 1 to 8"')
  })
})
