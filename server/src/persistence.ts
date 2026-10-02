import * as Y from 'yjs'
import type { RoomStorage } from './storage/types.js'

const CLOSE_ATTEMPTS = 3

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface PersistenceOptions {
  /** How long edits are collected before being written as one row. */
  flushMs: number
  /** Stored rows per room before they are squashed into a single snapshot. */
  compactAfter: number
  /** How long to wait before retrying a failed write. */
  retryMs: number
  now: () => number
  onError: (error: unknown, context: string) => void
}

/**
 * Saves one room's document to storage as it changes.
 *
 * Edits are buffered for a short time and written as one merged update, so a
 * burst of keystrokes costs one database write rather than one each. Writes
 * for a room run one at a time, in order. If the server dies before a flush,
 * nothing is lost for good: connected clients hold the full document and
 * send whatever the server is missing when they reconnect.
 */
export class RoomPersistence {
  private pending: Uint8Array[] = []
  private timer: NodeJS.Timeout | null = null
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly roomId: string,
    private readonly doc: Y.Doc,
    private readonly storage: RoomStorage,
    /** Number of rows currently stored for this room. */
    private stored: number,
    private readonly options: PersistenceOptions,
  ) {
    doc.on('update', this.onUpdate)
  }

  /** Writes anything buffered. Resolves once it is stored (or the attempt failed and was logged). */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.pending.length === 0) return
      const batch = this.pending
      this.pending = []
      const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch)
      try {
        await this.storage.append(this.roomId, merged, this.options.now())
        this.stored++
      } catch (error) {
        // Keep the edits and try again shortly; the database may be briefly unreachable.
        this.pending.unshift(merged)
        this.options.onError(error, `saving room ${this.roomId}`)
        this.schedule(this.options.retryMs)
        return
      }
      if (this.stored >= this.options.compactAfter) await this.compact()
    })
  }

  /** Final save when the room leaves memory. The document must still be alive. */
  close(): Promise<void> {
    this.closed = true
    this.doc.off('update', this.onUpdate)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.enqueue(async () => {
      // A snapshot covers buffered edits too, so one write does both jobs.
      if (this.pending.length === 0 && this.stored <= 1) return
      // Nothing retries after this, so give a briefly unreachable database a
      // few chances before giving up on edits that are only in memory.
      for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
        if (await this.compact()) return
        if (this.pending.length === 0) return // only tidying failed; nothing is at risk
        if (attempt < CLOSE_ATTEMPTS) await delay(this.options.retryMs)
      }
      this.options.onError(
        new Error('unsaved edits were dropped'),
        `saving room ${this.roomId} before unloading it`,
      )
    })
  }

  private onUpdate = (update: Uint8Array): void => {
    this.pending.push(update)
    this.schedule(this.options.flushMs)
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  /** Returns whether the snapshot was stored. */
  private async compact(): Promise<boolean> {
    // The snapshot is taken in the same tick the buffer is emptied, so it
    // contains every edit that is no longer in the buffer.
    const covered = this.pending
    this.pending = []
    const snapshot = Y.encodeStateAsUpdate(this.doc)
    try {
      await this.storage.compact(this.roomId, snapshot, this.options.now())
      this.stored = 1
      return true
    } catch (error) {
      this.pending = covered.concat(this.pending)
      this.options.onError(error, `compacting room ${this.roomId}`)
      this.schedule(this.options.retryMs)
      return false
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job)
    this.queue = run.catch((error) => this.options.onError(error, `saving room ${this.roomId}`))
    return this.queue
  }
}
