const WINDOW_SECONDS = 10

/** Counts incoming WebSocket messages and reports a rate over the last few seconds. */
export class Metrics {
  private readonly startedAt: number
  // Messages per one-second bucket, keyed by the second they arrived in.
  private readonly buckets = new Map<number, number>()
  private total = 0

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  recordMessage(): void {
    const second = Math.floor(this.now() / 1000)
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + 1)
    this.total++
    if (this.buckets.size > WINDOW_SECONDS * 2) this.prune(second)
  }

  /** Average over the last 10 complete seconds, so a half-finished second does not skew it. */
  messagesPerSecond(): number {
    const current = Math.floor(this.now() / 1000)
    this.prune(current)
    let count = 0
    for (const [second, messages] of this.buckets) {
      if (second < current) count += messages
    }
    return Math.round((count / WINDOW_SECONDS) * 10) / 10
  }

  get messagesTotal(): number {
    return this.total
  }

  uptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAt) / 1000)
  }

  private prune(current: number): void {
    for (const second of this.buckets.keys()) {
      if (second < current - WINDOW_SECONDS) this.buckets.delete(second)
    }
  }
}
