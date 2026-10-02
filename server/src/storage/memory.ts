import type { RoomStorage } from './types.js'

interface StoredRoom {
  updates: Uint8Array[]
  lastActiveAt: number
}

/** Keeps rooms in process memory only. Used when no database is configured, and in tests. */
export class MemoryStorage implements RoomStorage {
  private readonly rooms = new Map<string, StoredRoom>()

  async init(): Promise<void> {}

  async load(roomId: string): Promise<Uint8Array[]> {
    return [...(this.rooms.get(roomId)?.updates ?? [])]
  }

  async append(roomId: string, update: Uint8Array, now: number): Promise<void> {
    const room = this.rooms.get(roomId) ?? { updates: [], lastActiveAt: now }
    room.updates.push(update.slice())
    room.lastActiveAt = now
    this.rooms.set(roomId, room)
  }

  async compact(roomId: string, snapshot: Uint8Array, now: number): Promise<void> {
    const lastActiveAt = this.rooms.get(roomId)?.lastActiveAt ?? now
    this.rooms.set(roomId, { updates: [snapshot.slice()], lastActiveAt })
  }

  async touch(roomId: string, now: number): Promise<void> {
    const room = this.rooms.get(roomId)
    if (room) room.lastActiveAt = now
  }

  async deleteInactive(before: number): Promise<string[]> {
    const deleted: string[] = []
    for (const [id, room] of this.rooms) {
      if (room.lastActiveAt < before) {
        this.rooms.delete(id)
        deleted.push(id)
      }
    }
    return deleted
  }

  async close(): Promise<void> {}
}
