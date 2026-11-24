export type Tone = 'dim' | 'ok' | 'bad' | 'warn' | 'add' | 'del'
export type Line = { t: string; tone?: Tone }

export type Origin = {
  by: string
  kind: 'human' | 'agent' | 'ci'
  via?: string
}

export type Media = {
  id: string
  title: string
  caption?: string
  origin: Origin
} & (
  | {
      kind: 'compare'
      before: string
      after: string
      beforeLabel?: string
      afterLabel?: string
    }
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string }
  | { kind: 'page'; src: string }
  | { kind: 'frame'; label: 'Recording' | 'Interactive'; html: string }
)

export type TestResult = 'pass' | 'fail' | 'skipped'

export type TestCase = {
  suite: string
  name: string
  ms: number
  base: TestResult | 'missing'
  head: TestResult
  shot?: { before: string; after: string; note: string }
}

export type TestRun = {
  runner: string
  run: number
  tree: string
  origin: Origin
  cases: Array<TestCase>
}
