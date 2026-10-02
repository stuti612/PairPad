import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CLOSE_LOAD_FAILED, TEXT_KEY } from '../src/protocol.js'
import type { PairPadServerOptions } from '../src/server.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { PostgresStorage, type PostgresClient } from '../src/storage/postgres.js'
import { SqliteStorage } from '../src/storage/sqlite.js'
import type { RoomStorage } from '../src/storage/types.js'
import { sleep, startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000

let tempDir: string
let pglite: PGlite
let servers: TestServer[] = []
let clients: TestClient[] = []
const errors: string[] = []

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pairpad-persist-'))
  pglite = new PGlite()
})

afterEach(async () => {
  for (const client of clients) client.close()
  for (const ts of servers) await ts.server.close()
  clients = []
  servers = []
  errors.length = 0
})

afterAll(async () => {
  await pglite.close()
  await rm(tempDir, { recursive: true, force: true })
})

async function start(options: PairPadServerOptions): Promise<TestServer> {
  const ts = await startTestServer({
    onError: (error, context) => errors.push(`${context}: ${String(error)}`),
    ...options,
  })
  servers.push(ts)
  return ts
}

async function stop(ts: TestServer): Promise<void> {
  servers = servers.filter((other) => other !== ts)
  await ts.server.close()
}

function connect(ts: TestServer, roomId: string, doc?: Y.Doc): Promise<TestClient> {
  const client = new TestClient(ts.wsUrl, roomId, doc)
  clients.push(client)
  return client.ready()
}

const serverText = (ts: TestServer, roomId: string) =>
  ts.server.rooms.get(roomId)?.doc.getText(TEXT_KEY).toString()

/** What a brand-new server would give a brand-new client for this room. */
async function storedText(storage: RoomStorage, roomId: string): Promise<string> {
  const doc = new Y.Doc()
  for (const update of await storage.load(roomId)) Y.applyUpdate(doc, update)
  return doc.getText(TEXT_KEY).toString()
}

// Each "restart" opens the same database again, the way a new process would.
const databases = [
  {
    name: 'SQLite',
    open: (name: string): RoomStorage => new SqliteStorage(path.join(tempDir, `${name}.sqlite`)),
  },
  {
    name: 'Postgres (PGlite)',
    // No close hook: the engine outlives each simulated server process.
    open: (_name: string): RoomStorage => new PostgresStorage(pglite as unknown as PostgresClient),
  },
]

describe.each(databases)('persistence with $name', ({ open }) => {
  it('brings back the text and the language after a restart', async () => {
    const first = await start({ storage: open('restart') })
    const alice = await connect(first, 'restart1')
    alice.text.insert(0, 'print("saved")')
    alice.doc.getMap('meta').set('language', 'python')
    await waitFor(() => serverText(first, 'restart1') === 'print("saved")')
    // Stopping straight away: the edit is still in the write buffer, and
    // shutdown has to save it.
    await stop(first)

    const second = await start({ storage: open('restart') })
    const bob = await connect(second, 'restart1')
    expect(bob.text.toString()).toBe('print("saved")')
    expect(bob.doc.getMap('meta').get('language')).toBe('python')

    // And editing carries on from there, across another restart.
    bob.text.insert(bob.text.length, ' # twice')
    await waitFor(() => serverText(second, 'restart1') === 'print("saved") # twice')
    await stop(second)

    const third = await start({ storage: open('restart') })
    const carol = await connect(third, 'restart1')
    expect(carol.text.toString()).toBe('print("saved") # twice')
  })

  it('keeps concurrent edits from two people across a restart', async () => {
    const first = await start({ storage: open('concurrent') })
    const alice = await connect(first, 'concur01')
    const bob = await connect(first, 'concur01')
    for (let i = 0; i < 50; i++) {
      alice.text.insert(0, 'a')
      bob.text.insert(0, 'b')
      if (i % 10 === 0) await sleep(1)
    }
    await waitFor(() => serverText(first, 'concur01')?.length === 100)
    const before = serverText(first, 'concur01')
    await stop(first)

    const second = await start({ storage: open('concurrent') })
    const carol = await connect(second, 'concur01')
    expect(carol.text.toString()).toBe(before)
  })
})

describe('room lifecycle', () => {
  it('unloads an empty room from memory and reloads it when someone returns', async () => {
    const storage = new MemoryStorage()
    const ts = await start({ storage, idleUnloadMs: 0 })
    const alice = await connect(ts, 'idle0001')
    alice.text.insert(0, 'back soon')
    await waitFor(() => serverText(ts, 'idle0001') === 'back soon')

    alice.close()
    await waitFor(() => ts.server.rooms.roomCount === 0)
    const bob = await connect(ts, 'idle0001')
    expect(bob.text.toString()).toBe('back soon')
    expect(ts.server.rooms.roomCount).toBe(1)
  })

  it('keeps a room in memory while someone reconnects within the grace period', async () => {
    const ts = await start({ storage: new MemoryStorage(), idleUnloadMs: 200 })
    const alice = await connect(ts, 'grace001')
    const room = ts.server.rooms.get('grace001')
    alice.close()
    await sleep(50)
    await connect(ts, 'grace001')
    await sleep(300)
    expect(ts.server.rooms.get('grace001')).toBe(room)
  })

  it('stores nothing for a room nobody typed in', async () => {
    const storage = new MemoryStorage()
    const ts = await start({ storage, idleUnloadMs: 0 })
    const alice = await connect(ts, 'empty001')
    alice.awareness.setLocalStateField('user', { name: 'Ada' })
    alice.close()
    await waitFor(() => ts.server.rooms.roomCount === 0)
    expect(await storage.load('empty001')).toEqual([])
  })

  it('writes a burst of edits as one row, not one per keystroke', async () => {
    const storage = new MemoryStorage()
    const ts = await start({ storage, flushMs: 50 })
    const alice = await connect(ts, 'burst001')
    for (const char of 'forty characters typed in a single burst') alice.text.insert(alice.text.length, char)
    await waitFor(() => serverText(ts, 'burst001')?.length === 40)
    await ts.server.rooms.flushAll()

    const rows = await storage.load('burst001')
    expect(rows.length).toBeLessThanOrEqual(3)
    expect(await storedText(storage, 'burst001')).toBe('forty characters typed in a single burst')
  })

  it('squashes stored updates into one snapshot once everyone has left', async () => {
    const storage = new MemoryStorage()
    const ts = await start({ storage, flushMs: 5, idleUnloadMs: 0 })
    const alice = await connect(ts, 'squash01')
    for (let i = 0; i < 6; i++) {
      alice.text.insert(alice.text.length, `line ${i}\n`)
      await waitFor(() => serverText(ts, 'squash01')?.endsWith(`line ${i}\n`) === true)
      await ts.server.rooms.flushAll()
    }
    expect((await storage.load('squash01')).length).toBe(6)

    alice.close()
    await waitFor(() => ts.server.rooms.roomCount === 0)
    const bob = await connect(ts, 'squash01')
    expect((await storage.load('squash01')).length).toBe(1)
    expect(bob.text.toString()).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nline 5\n')
  })

  it('squashes while the room is in use once enough rows pile up', async () => {
    const storage = new MemoryStorage()
    const ts = await start({ storage, flushMs: 5, compactAfter: 4 })
    const alice = await connect(ts, 'squash02')
    for (let i = 0; i < 10; i++) {
      alice.text.insert(alice.text.length, String(i))
      await waitFor(() => serverText(ts, 'squash02')?.endsWith(String(i)) === true)
      await ts.server.rooms.flushAll()
      expect((await storage.load('squash02')).length).toBeLessThan(4)
    }
    expect(await storedText(storage, 'squash02')).toBe('0123456789')
  })

  it('a client that still has the document restores it after a crash lost unsaved edits', async () => {
    const file = path.join(tempDir, 'crash.sqlite')
    // A long flush delay stands in for a crash: this server never writes.
    const crashed = await start({ storage: new SqliteStorage(file), flushMs: 60 * 60 * 1000 })
    const alice = await connect(crashed, 'crash001')
    alice.text.insert(0, 'only in my browser')
    await waitFor(() => serverText(crashed, 'crash001') === 'only in my browser')

    const restarted = await start({ storage: new SqliteStorage(file) })
    const fresh = await connect(restarted, 'crash001')
    expect(fresh.text.toString()).toBe('')

    // Alice's browser reconnects with its local copy; sync uploads what the server lacks.
    await connect(restarted, 'crash001', alice.doc)
    await waitFor(() => fresh.text.toString() === 'only in my browser')
    await restarted.server.rooms.flushAll()
    const reader = new SqliteStorage(file)
    await reader.init()
    expect(await storedText(reader, 'crash001')).toBe('only in my browser')
    await reader.close()
  })
})

describe('storage failures', () => {
  it('keeps edits and retries when a write fails', async () => {
    const storage = new MemoryStorage()
    let failures = 2
    const append = storage.append.bind(storage)
    storage.append = async (...args) => {
      if (failures-- > 0) throw new Error('database unavailable')
      return append(...args)
    }
    const ts = await start({ storage, flushMs: 5, retryMs: 20 })
    const alice = await connect(ts, 'retry001')
    alice.text.insert(0, 'not lost')

    await waitFor(() => errors.length === 2)
    await expect.poll(() => storedText(storage, 'retry001')).toBe('not lost')
    expect(errors[0]).toContain('database unavailable')
    // The room kept working for everyone in the meantime.
    expect(alice.closeCode).toBeNull()
  })

  it('retries the final save when the database is briefly down as a room unloads', async () => {
    const storage = new MemoryStorage()
    let failures = 2
    const compact = storage.compact.bind(storage)
    storage.compact = async (...args) => {
      if (failures-- > 0) throw new Error('database unavailable')
      return compact(...args)
    }
    // The long flush delay means the edit is only in memory when Alice leaves.
    const ts = await start({ storage, flushMs: 60_000, retryMs: 10, idleUnloadMs: 0 })
    const alice = await connect(ts, 'final001')
    alice.text.insert(0, 'saved on the way out')
    await waitFor(() => serverText(ts, 'final001') === 'saved on the way out')
    alice.close()

    await expect.poll(() => storedText(storage, 'final001')).toBe('saved on the way out')
    expect(errors.length).toBe(2)
  })

  it('closes the connection when a room cannot be loaded, and recovers afterwards', async () => {
    const storage = new MemoryStorage()
    await storage.append('broken01', Y.encodeStateAsUpdate(docWith('still there')), Date.now())
    let down = true
    const load = storage.load.bind(storage)
    storage.load = async (roomId) => {
      if (down) throw new Error('database unavailable')
      return load(roomId)
    }
    const ts = await start({ storage })

    const refused = new TestClient(ts.wsUrl, 'broken01')
    clients.push(refused)
    await waitFor(() => refused.closeCode !== null)
    expect(refused.closeCode).toBe(CLOSE_LOAD_FAILED)
    expect(ts.server.rooms.roomCount).toBe(0)

    down = false
    const retry = await connect(ts, 'broken01')
    expect(retry.text.toString()).toBe('still there')
  })

  it('skips an unreadable stored update instead of refusing to open the room', async () => {
    const storage = new MemoryStorage()
    await storage.append('corrupt1', Y.encodeStateAsUpdate(docWith('good part')), Date.now())
    await storage.append('corrupt1', new Uint8Array([255, 255, 255, 255]), Date.now())
    const ts = await start({ storage })

    const alice = await connect(ts, 'corrupt1')
    expect(alice.text.toString()).toBe('good part')
    expect(errors.some((message) => message.includes('corrupt1'))).toBe(true)
  })
})

describe('cleanup of inactive rooms', () => {
  it('deletes rooms unused for 7 days and keeps recent or occupied ones', async () => {
    let now = Date.UTC(2026, 0, 1)
    const storage = new MemoryStorage()
    const ts = await start({ storage, now: () => now, idleUnloadMs: 0, flushMs: 5 })

    const edit = async (roomId: string, text: string, stay = false) => {
      const client = await connect(ts, roomId)
      client.text.insert(0, text)
      await waitFor(() => serverText(ts, roomId) === text)
      await ts.server.rooms.flushAll()
      if (!stay) {
        client.close()
        await waitFor(() => ts.server.rooms.get(roomId) === undefined)
      }
      return client
    }

    await edit('stale001', 'abandoned')
    await edit('busy0001', 'someone is still here', true)

    now += 6 * DAY
    expect(await ts.server.cleanup()).toEqual([])

    now += 2 * DAY
    await edit('fresh001', 'written today')
    expect(await ts.server.cleanup()).toEqual(['stale001'])

    expect(await storage.load('stale001')).toEqual([])
    expect(await storedText(storage, 'fresh001')).toBe('written today')
    expect(await storedText(storage, 'busy0001')).toBe('someone is still here')
    // The link still works; it just opens an empty pad.
    const visitor = await connect(ts, 'stale001')
    expect(visitor.text.toString()).toBe('')
  })

  it('counts opening a pad as activity, even without editing', async () => {
    let now = Date.UTC(2026, 0, 1)
    const storage = new MemoryStorage()
    const ts = await start({ storage, now: () => now, idleUnloadMs: 0, flushMs: 5 })

    const author = await connect(ts, 'read0001')
    author.text.insert(0, 'notes')
    await waitFor(() => serverText(ts, 'read0001') === 'notes')
    author.close()
    await waitFor(() => ts.server.rooms.roomCount === 0)

    now += 5 * DAY
    const reader = await connect(ts, 'read0001')
    expect(reader.text.toString()).toBe('notes')
    reader.close()
    await waitFor(() => ts.server.rooms.roomCount === 0)

    now += 4 * DAY // 9 days since the edit, 4 since it was last opened
    expect(await ts.server.cleanup()).toEqual([])
    now += 4 * DAY // 8 days since it was last opened
    expect(await ts.server.cleanup()).toEqual(['read0001'])
  })

  it('runs on a timer', async () => {
    let now = Date.UTC(2026, 0, 1)
    const storage = new MemoryStorage()
    await storage.append('timer001', Y.encodeStateAsUpdate(docWith('old')), now)
    now += 8 * DAY
    await start({ storage, now: () => now, cleanupIntervalMs: 20 })
    await expect.poll(() => storage.load('timer001')).toEqual([])
  })
})

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText(TEXT_KEY).insert(0, text)
  return doc
}
