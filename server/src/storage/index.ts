import path from 'node:path'
import { connectPostgres } from './postgres.js'
import { SqliteStorage } from './sqlite.js'
import type { RoomStorage } from './types.js'

export { MemoryStorage } from './memory.js'
export { PostgresStorage } from './postgres.js'
export { SqliteStorage } from './sqlite.js'
export type { RoomStorage } from './types.js'

const DEFAULT_SQLITE_FILE = path.resolve(import.meta.dirname, '../../data/pairpad.sqlite')

export interface StorageChoice {
  storage: RoomStorage
  /** Human-readable description for the startup log (never includes credentials). */
  description: string
}

/**
 * Picks the storage backend from the environment:
 * DATABASE_URL set  -> Postgres (production, e.g. Replit's built-in database)
 * otherwise         -> SQLite at SQLITE_PATH, or server/data/pairpad.sqlite
 */
export async function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<StorageChoice> {
  if (env.DATABASE_URL) {
    return { storage: await connectPostgres(env.DATABASE_URL), description: 'Postgres' }
  }
  const file = env.SQLITE_PATH ?? DEFAULT_SQLITE_FILE
  return { storage: new SqliteStorage(file), description: `SQLite (${file})` }
}
