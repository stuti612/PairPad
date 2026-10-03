const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface QuotaLimits {
  /** AI requests one room may make in any 60-minute window. */
  perRoomPerHour: number
  /** AI requests the whole server may make per UTC day. */
  perDay: number
}

export interface QuotaStatus {
  room: { limit: number; remaining: number; resetsInSeconds: number }
  day: { limit: number; remaining: number; resetsInSeconds: number }
}

/**
 * Caps AI use so a public demo stays inside the providers' free allowances.
 * One AI request is counted once, although it can take up to four model
 * calls (write, judge, and one retry of each).
 *
 * Counts live in memory, so a server restart resets them; the providers'
 * own limits still apply behind these.
 */
export class AiQuota {
  private readonly roomUses = new Map<string, number[]>()
  private day = -1
  private dayUses = 0

  constructor(
    private readonly limits: QuotaLimits,
    private readonly now: () => number = Date.now,
  ) {}

  status(roomId: string): QuotaStatus {
    const now = this.now()
    this.rollDay(now)
    const uses = this.recentUses(roomId, now)
    const oldest = uses[0]
    return {
      room: {
        limit: this.limits.perRoomPerHour,
        remaining: Math.max(0, this.limits.perRoomPerHour - uses.length),
        resetsInSeconds: oldest === undefined ? 0 : Math.ceil((oldest + HOUR_MS - now) / 1000),
      },
      day: {
        limit: this.limits.perDay,
        remaining: Math.max(0, this.limits.perDay - this.dayUses),
        resetsInSeconds: Math.ceil(((this.day + 1) * DAY_MS - now) / 1000),
      },
    }
  }

  /** Records one request if both limits allow it. Returns null when it may go ahead. */
  take(roomId: string): string | null {
    const status = this.status(roomId)
    if (status.day.remaining === 0) {
      return `The AI has used today's free allowance. It resets in ${formatWait(status.day.resetsInSeconds)}.`
    }
    if (status.room.remaining === 0) {
      return `This pad has used its ${this.limits.perRoomPerHour} AI requests for the hour. Try again in ${formatWait(status.room.resetsInSeconds)}.`
    }
    const now = this.now()
    this.roomUses.set(roomId, [...this.recentUses(roomId, now), now])
    this.dayUses++
    return null
  }

  private recentUses(roomId: string, now: number): number[] {
    const uses = (this.roomUses.get(roomId) ?? []).filter((time) => time > now - HOUR_MS)
    if (uses.length === 0) this.roomUses.delete(roomId)
    else this.roomUses.set(roomId, uses)
    return uses
  }

  private rollDay(now: number): void {
    const day = Math.floor(now / DAY_MS)
    if (day !== this.day) {
      this.day = day
      this.dayUses = 0
    }
  }
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, seconds)} seconds`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 90) return `${minutes} minutes`
  return `${Math.round(minutes / 60)} hours`
}
