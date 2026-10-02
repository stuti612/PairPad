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
 *
 * A deployment's local disk may not survive a restart, so a deployment
 * without DATABASE_URL refuses to start rather than quietly saving pads to
 * a file that will disappear. Replit sets REPLIT_DEPLOYMENT in deployments;
 * set REQUIRE_POSTGRES=1 for the same check anywhere else.
 */
export async function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<StorageChoice> {
  if (env.DATABASE_URL) {
    return { storage: await connectPostgres(env.DATABASE_URL), description: 'Postgres' }
  }
  if (env.REPLIT_DEPLOYMENT || env.REQUIRE_POSTGRES) {
    throw new Error(
      'DATABASE_URL is not set. This deployment needs a Postgres database: ' +
        'add one and make its connection string available as DATABASE_URL.',
    )
  }
  const file = env.SQLITE_PATH ?? DEFAULT_SQLITE_FILE
  return { storage: new SqliteStorage(file), description: `SQLite (${file})` }
}
