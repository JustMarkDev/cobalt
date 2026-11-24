import { run } from '../domain/convex'
import type { ConvexCall } from '../domain/convex'
import type { EventLog, EventRecord } from '../events'

export class ConvexEventFeed {
  private pulling: Promise<void> | null = null
  private again = false

  private goAgain() {
    return this.again
  }

  constructor(
    private readonly call: ConvexCall,
    readonly log: EventLog,
    private readonly onAccess?: (rev: number) => void,
  ) {}

  pull(): Promise<void> {
    if (this.pulling) {
      this.again = true
      return this.pulling
    }
    this.pulling = (async () => {
      try {
        do {
          this.again = false
          if (this.onAccess) {
            const h = await run<{ access: number }>(
              this.call,
              'query',
              'forge/events:head',
              {},
              'system',
            )
            this.onAccess(h.access)
          }
          for (;;) {
            const batch = await run<Array<string>>(
              this.call,
              'query',
              'forge/events:since',
              { after: this.log.head, limit: 500 },
              'system',
            )
            for (const json of batch)
              this.log.ingest(JSON.parse(json) as EventRecord)
            if (batch.length < 500) break
          }
        } while (this.goAgain())
      } finally {
        this.pulling = null
      }
    })()
    return this.pulling
  }

  async start(keep = 5000) {
    const h = await run<{ head: number; oldest: number }>(
      this.call,
      'query',
      'forge/events:head',
      {},
      'system',
    )
    if (this.log.head === 0 && h.head > keep) {
      const batch = await run<Array<string>>(
        this.call,
        'query',
        'forge/events:since',
        { after: h.head - keep, limit: 1 },
        'system',
      )
      for (const json of batch) this.log.ingest(JSON.parse(json) as EventRecord)
    }
    await this.pull()
  }
}
