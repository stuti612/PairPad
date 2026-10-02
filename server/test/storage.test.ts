import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storageFromEnv } from '../src/storage/index.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { connectPostgres, PostgresStorage, type PostgresClient } from '../src/storage/postgres.js'
import { SqliteStorage } from '../src/storage/sqlite.js'
import type { RoomStorage } from '../src/storage/types.js'

// Every backend must behave the same, so one set of tests runs against all of
// them. Postgres is exercised through PGlite (the real Postgres engine
// compiled to WebAssembly), twice: called directly, and over a TCP socket
// through the `pg` driver and connection pool used in production. Set
// TEST_DATABASE_URL to also run against a Postgres server of your own.

interface Backend {
  name: string
  create(): Promise<RoomStorage>
  dispose?(): Promise<void>
}

let tempDir: string | undefined
let pglite: PGlite | undefined
let socketDb: PGlite | undefined
let socketServer: PGLiteSocketServer | undefined
let socketStorage: PostgresStorage | undefined
const WIPE = 'TRUNCATE rooms, room_updates'

const backends: Backend[] = [
  { name: 'memory', create: async () => new MemoryStorage() },
  {
    name: 'sqlite',
    async create() {
      tempDir ??= await mkdtemp(path.join(tmpdir(), 'pairpad-storage-'))
      return new SqliteStorage(path.join(tempDir, `${Math.random().toString(36).slice(2)}.sqlite`))
    },
    async dispose() {
      if (tempDir) await rm(tempDir, { recursive: true, force: true })
    },
  },
  {
    name: 'postgres (PGlite)',
    async create() {
      pglite ??= new PGlite()
      const storage = new PostgresStorage(pglite as unknown as PostgresClient)
      await storage.init()
      await pglite.query(WIPE)
      return storage
    },
    async dispose() {
      await pglite?.close()
    },
  },
  {
    name: 'postgres (pg driver over a socket)',
    async create() {
      if (!socketStorage) {
        socketDb = await PGlite.create()
        socketServer = new PGLiteSocketServer({ db: socketDb, host: '127.0.0.1', port: 0 })
        await socketServer.start()
        socketStorage = await connectPostgres(
          `postgres://postgres:postgres@${socketServer.getServerConn()}/postgres`,
        )
      }
      await socketStorage.init()
      await socketDb!.query(WIPE)
      // The socket server accepts one connection at a time, so every test
      // shares one pool; only dispose() really closes it.
      return Object.create(socketStorage, { close: { value: async () => {} } }) as RoomStorage
    },
    async dispose() {
      await socketStorage?.close()
      await socketServer?.stop()
      await socketDb?.close()
    },
  },
]

if (process.env.TEST_DATABASE_URL) {
  const url = process.env.TEST_DATABASE_URL
  backends.push({
    name: 'postgres (pg driver)',
    async create() {
      const storage = await connectPostgres(url)
      await storage.init()
      await (storage as unknown as { client: PostgresClient }).client.query(WIPE)
      return storage
    },
  })
}

const bytes = (...values: number[]) => new Uint8Array(values)
const asArrays = (updates: Uint8Array[]) => updates.map((update) => [...update])

describe.each(backends)('$name storage', (backend) => {
  let storage: RoomStorage

  beforeEach(async () => {
    storage = await backend.create()
    await storage.init()
  })
  afterEach(() => storage.close())
  afterAll(() => backend.dispose?.())

  it('returns nothing for a room it has never seen', async () => {
    expect(await storage.load('unknown1')).toEqual([])
  })

  it('returns appended updates in the order they were added', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.append('room0001', bytes(2, 2), 101)
    await storage.append('room0001', bytes(3, 3, 3), 102)
    expect(asArrays(await storage.load('room0001'))).toEqual([[1], [2, 2], [3, 3, 3]])
  })

  it('stores binary data byte for byte', async () => {
    const all = new Uint8Array(1024).map((_, i) => i % 256)
    await storage.append('room0001', all, 100)
    await storage.append('room0001', bytes(), 100)
    const [first, second] = await storage.load('room0001')
    expect([...first!]).toEqual([...all])
    expect([...second!]).toEqual([])
  })

  it('stores a slice of a larger buffer without its neighbours', async () => {
    const backing = bytes(9, 9, 1, 2, 3, 9, 9)
    await storage.append('room0001', backing.subarray(2, 5), 100)
    expect(asArrays(await storage.load('room0001'))).toEqual([[1, 2, 3]])
  })

  it('keeps rooms separate', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.append('room0002', bytes(2), 100)
    expect(asArrays(await storage.load('room0001'))).toEqual([[1]])
    expect(asArrays(await storage.load('room0002'))).toEqual([[2]])
  })

  it('survives being initialised twice', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.init()
    expect(asArrays(await storage.load('room0001'))).toEqual([[1]])
  })

  it('compact replaces every update with the snapshot, for that room only', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.append('room0001', bytes(2), 100)
    await storage.append('room0002', bytes(7), 100)

    await storage.compact('room0001', bytes(1, 2), 200)
    expect(asArrays(await storage.load('room0001'))).toEqual([[1, 2]])
    expect(asArrays(await storage.load('room0002'))).toEqual([[7]])

    // Updates added after a compaction come after the snapshot.
    await storage.append('room0001', bytes(3), 300)
    expect(asArrays(await storage.load('room0001'))).toEqual([[1, 2], [3]])
  })

  it('compact works for a room with nothing stored yet', async () => {
    await storage.compact('room0001', bytes(5), 100)
    expect(asArrays(await storage.load('room0001'))).toEqual([[5]])
    expect(await storage.deleteInactive(101)).toEqual(['room0001'])
  })

  it('deletes only rooms that were last active before the cutoff', async () => {
    await storage.append('oldroom1', bytes(1), 100)
    await storage.append('oldroom1', bytes(2), 150)
    await storage.append('newroom1', bytes(3), 500)

    expect(await storage.deleteInactive(100)).toEqual([])
    expect(await storage.deleteInactive(151)).toEqual(['oldroom1'])
    expect(await storage.load('oldroom1')).toEqual([])
    expect(asArrays(await storage.load('newroom1'))).toEqual([[3]])
    expect(await storage.deleteInactive(151)).toEqual([])
  })

  it('an append counts as activity', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.append('room0001', bytes(2), 900)
    expect(await storage.deleteInactive(500)).toEqual([])
  })

  it('touch counts as activity, and does not create rooms', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.touch('room0001', 900)
    await storage.touch('ghost001', 100)
    expect(await storage.deleteInactive(500)).toEqual([])
    // The untouched-into-existence room was never stored, so there is nothing to delete.
    expect(await storage.deleteInactive(1000)).toEqual(['room0001'])
  })

  it('compact does not count as activity', async () => {
    await storage.append('room0001', bytes(1), 100)
    await storage.compact('room0001', bytes(1), 900)
    expect(await storage.deleteInactive(500)).toEqual(['room0001'])
  })
})

describe('choosing storage from the environment', () => {
  it('uses SQLite when no database URL is given', async () => {
    const { storage, description } = await storageFromEnv({ SQLITE_PATH: ':memory:' })
    expect(storage).toBeInstanceOf(SqliteStorage)
    expect(description).toContain('SQLite')
  })

  it('uses Postgres when a database URL is given, without logging the credentials', async () => {
    const { storage, description } = await storageFromEnv({
      DATABASE_URL: 'postgres://user:secret@db.invalid:5432/pads',
    })
    expect(storage).toBeInstanceOf(PostgresStorage)
    expect(description).toBe('Postgres')
    await storage.close()
  })

  it.each(['REPLIT_DEPLOYMENT', 'REQUIRE_POSTGRES'])(
    'refuses to fall back to a local file in a deployment (%s)',
    async (flag) => {
      await expect(storageFromEnv({ [flag]: '1' })).rejects.toThrow('DATABASE_URL is not set')
    },
  )
})
