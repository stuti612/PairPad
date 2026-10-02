import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RoomStorage } from './types.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_updates (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS room_updates_by_room ON room_updates (room_id, seq);
`

const UPSERT_ROOM = `
  INSERT INTO rooms (id, created_at, last_active_at) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET last_active_at = excluded.last_active_at
`

/**
 * SQLite storage for local development and tests, using Node's built-in
 * `node:sqlite` so there is no native module to compile. Pass ":memory:" for
 * a throwaway database.
 */
export class SqliteStorage implements RoomStorage {
  private db!: DatabaseSync

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    // Imported here so a Postgres deployment never loads the SQLite module.
    const { DatabaseSync } = await import('node:sqlite')
    if (this.file !== ':memory:') {
      mkdirSync(path.dirname(this.file), { recursive: true })
    }
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  async load(roomId: string): Promise<Uint8Array[]> {
    const rows = this.db
      .prepare('SELECT data FROM room_updates WHERE room_id = ? ORDER BY seq')
      .all(roomId)
    return rows.map((row) => row.data as Uint8Array)
  }

  async append(roomId: string, update: Uint8Array, now: number): Promise<void> {
    this.transaction(() => {
      this.db.prepare(UPSERT_ROOM).run(roomId, now, now)
      this.db.prepare('INSERT INTO room_updates (room_id, data) VALUES (?, ?)').run(roomId, update)
    })
  }

  async compact(roomId: string, snapshot: Uint8Array, now: number): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO rooms (id, created_at, last_active_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
        )
        .run(roomId, now, now)
      this.db.prepare('DELETE FROM room_updates WHERE room_id = ?').run(roomId)
      this.db
        .prepare('INSERT INTO room_updates (room_id, data) VALUES (?, ?)')
        .run(roomId, snapshot)
    })
  }

  async touch(roomId: string, now: number): Promise<void> {
    this.db.prepare('UPDATE rooms SET last_active_at = ? WHERE id = ?').run(now, roomId)
  }

  async deleteInactive(before: number): Promise<string[]> {
    return this.transaction(() => {
      const ids = this.db
        .prepare('SELECT id FROM rooms WHERE last_active_at < ?')
        .all(before)
        .map((row) => row.id as string)
      for (const id of ids) {
        this.db.prepare('DELETE FROM room_updates WHERE room_id = ?').run(id)
        this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
      }
      return ids
    })
  }

  async close(): Promise<void> {
    this.db?.close()
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
