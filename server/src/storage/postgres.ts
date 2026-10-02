import type { RoomStorage } from './types.js'

/**
 * The part of a Postgres client this storage needs. A `pg` Pool satisfies
 * it, and so does PGlite, which the tests use to run the same SQL against a
 * real Postgres engine without a server.
 */
export interface PostgresClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     created_at BIGINT NOT NULL,
     last_active_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS room_updates (
     seq BIGSERIAL PRIMARY KEY,
     room_id TEXT NOT NULL,
     data BYTEA NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS room_updates_by_room ON room_updates (room_id, seq)`,
]

/**
 * Postgres storage for production (Replit's built-in database).
 *
 * Each method is a single SQL statement. Statements that touch both tables
 * use data-modifying CTEs, which Postgres runs atomically, so no explicit
 * transactions or dedicated connections are needed.
 */
export class PostgresStorage implements RoomStorage {
  constructor(
    private readonly client: PostgresClient,
    private readonly onClose: () => Promise<void> = async () => {},
  ) {}

  async init(): Promise<void> {
    for (const statement of SCHEMA) {
      await this.client.query(statement)
    }
  }

  async load(roomId: string): Promise<Uint8Array[]> {
    const { rows } = await this.client.query(
      'SELECT data FROM room_updates WHERE room_id = $1 ORDER BY seq',
      [roomId],
    )
    return rows.map((row) => row.data as Uint8Array)
  }

  async append(roomId: string, update: Uint8Array, now: number): Promise<void> {
    await this.client.query(
      `WITH room AS (
         INSERT INTO rooms (id, created_at, last_active_at)
         VALUES ($1, $3::bigint, $3::bigint)
         ON CONFLICT (id) DO UPDATE SET last_active_at = EXCLUDED.last_active_at
         RETURNING id
       )
       INSERT INTO room_updates (room_id, data)
       SELECT id, $2::bytea FROM room`,
      [roomId, toBuffer(update), now],
    )
  }

  async compact(roomId: string, snapshot: Uint8Array, now: number): Promise<void> {
    // The DELETE only sees rows that existed before this statement, so it
    // removes the old updates and leaves the snapshot inserted alongside it.
    await this.client.query(
      `WITH room AS (
         INSERT INTO rooms (id, created_at, last_active_at)
         VALUES ($1, $3::bigint, $3::bigint)
         ON CONFLICT (id) DO NOTHING
       ),
       removed AS (
         DELETE FROM room_updates WHERE room_id = $1
       )
       INSERT INTO room_updates (room_id, data) VALUES ($1, $2::bytea)`,
      [roomId, toBuffer(snapshot), now],
    )
  }

  async touch(roomId: string, now: number): Promise<void> {
    await this.client.query('UPDATE rooms SET last_active_at = $2::bigint WHERE id = $1', [
      roomId,
      now,
    ])
  }

  async deleteInactive(before: number): Promise<string[]> {
    const { rows } = await this.client.query(
      `WITH gone AS (
         DELETE FROM rooms WHERE last_active_at < $1::bigint RETURNING id
       ),
       removed AS (
         DELETE FROM room_updates WHERE room_id IN (SELECT id FROM gone)
       )
       SELECT id FROM gone`,
      [before],
    )
    return rows.map((row) => row.id as string)
  }

  close(): Promise<void> {
    return this.onClose()
  }
}

// The pg driver only sends a Buffer as bytea; a plain Uint8Array would be
// serialised as JSON.
function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/** Connects to Postgres with a small connection pool. */
export async function connectPostgres(connectionString: string): Promise<PostgresStorage> {
  // Imported here so local SQLite runs never load the Postgres driver.
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString, max: 5 })
  // An idle connection dropping (database restart, network blip) must not
  // crash the server; the pool replaces it on the next query.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message))
  return new PostgresStorage(pool, () => pool.end())
}
