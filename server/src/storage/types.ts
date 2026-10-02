/**
 * Where room documents are kept between server restarts.
 *
 * A room is stored as a list of Yjs updates. Yjs updates can be applied in
 * any order and more than once with the same result, so implementations do
 * not need transactions across calls or strict ordering between them.
 *
 * Timestamps are milliseconds since the epoch and are passed in by the
 * caller, so tests can control the clock.
 */
export interface RoomStorage {
  /** Creates tables if needed. Called once before any other method. */
  init(): Promise<void>

  /** Every stored update for the room, oldest first. Empty for an unknown room. */
  load(roomId: string): Promise<Uint8Array[]>

  /** Adds one update and marks the room as active at `now`. */
  append(roomId: string, update: Uint8Array, now: number): Promise<void>

  /** Replaces everything stored for the room with a single snapshot update. */
  compact(roomId: string, snapshot: Uint8Array, now: number): Promise<void>

  /** Marks an existing room as active at `now`. Does nothing for an unknown room. */
  touch(roomId: string, now: number): Promise<void>

  /** Deletes rooms last active before `before` and returns their IDs. */
  deleteInactive(before: number): Promise<string[]>

  close(): Promise<void>
}
