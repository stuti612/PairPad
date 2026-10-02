import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Metrics } from '../src/metrics.js'
import {
  CLOSE_MALFORMED,
  CLOSE_ROOM_FULL,
  CLOSE_TOO_LARGE,
  TEXT_KEY,
} from '../src/protocol.js'
import type { PairPadServerOptions } from '../src/server.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { sleep, startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

let ts: TestServer
let clients: TestClient[] = []

async function start(options: PairPadServerOptions = {}): Promise<TestServer> {
  ts = await startTestServer(options)
  return ts
}

function open(roomId: string): TestClient {
  const client = new TestClient(ts.wsUrl, roomId)
  clients.push(client)
  return client
}

const connect = (roomId: string) => open(roomId).ready()

const serverText = (roomId: string) =>
  ts.server.rooms.get(roomId)?.doc.getText(TEXT_KEY).toString() ?? ''

const serverBytes = (roomId: string) =>
  Y.encodeStateAsUpdate(ts.server.rooms.get(roomId)!.doc).byteLength

afterEach(async () => {
  for (const client of clients) client.close()
  clients = []
  await ts.server.close()
})

describe('room size limit', () => {
  it('lets 10 people in and turns the 11th away', async () => {
    await start()
    const members = await Promise.all(Array.from({ length: 10 }, () => connect('full0001')))
    expect(ts.server.rooms.get('full0001')?.size).toBe(10)

    const eleventh = open('full0001')
    await waitFor(() => eleventh.closeCode !== null)
    expect(eleventh.closeCode).toBe(CLOSE_ROOM_FULL)
    expect(eleventh.synced).toBe(false)

    // The ten already inside are unaffected and still in sync.
    expect(ts.server.rooms.get('full0001')?.size).toBe(10)
    members[0]!.text.insert(0, 'still editing')
    await waitFor(() => members.every((member) => member.text.toString() === 'still editing'))
    expect(members.every((member) => member.closeCode === null)).toBe(true)
  })

  it('frees the place when someone leaves', async () => {
    await start()
    const members = await Promise.all(Array.from({ length: 10 }, () => connect('full0002')))
    members[3]!.close()
    await waitFor(() => ts.server.rooms.get('full0002')?.size === 9)

    const newcomer = await connect('full0002')
    expect(newcomer.closeCode).toBeNull()
    expect(ts.server.rooms.get('full0002')?.size).toBe(10)
  })

  it('counts each room separately', async () => {
    await start({ maxUsersPerRoom: 2 })
    await connect('pair0001')
    await connect('pair0001')
    const other = await connect('pair0002')
    expect(other.closeCode).toBeNull()

    const third = open('pair0001')
    await waitFor(() => third.closeCode !== null)
    expect(third.closeCode).toBe(CLOSE_ROOM_FULL)
  })

  it('holds the limit when many people arrive at the same moment', async () => {
    await start({ storage: slowStorage(30) })
    const crowd = Array.from({ length: 25 }, () => open('rush0001'))
    await waitFor(() => crowd.every((client) => client.synced || client.closeCode !== null))
    await sleep(50)

    expect(crowd.filter((client) => client.synced && client.closeCode === null).length).toBe(10)
    expect(crowd.filter((client) => client.closeCode === CLOSE_ROOM_FULL).length).toBe(15)
    expect(ts.server.rooms.get('rush0001')?.size).toBe(10)
  })
})

describe('document size limit', () => {
  it('accepts a document just under 1 MB and refuses to go over', async () => {
    await start()
    const alice = await connect('big00001')
    const bob = await connect('big00001')

    alice.text.insert(0, 'x'.repeat(1_000_000))
    await waitFor(() => bob.text.length === 1_000_000, 10_000)
    expect(alice.closeCode).toBeNull()

    alice.text.insert(0, 'y'.repeat(100_000))
    await waitFor(() => alice.closeCode !== null)
    expect(alice.closeCode).toBe(CLOSE_TOO_LARGE)

    // Nothing from the refused edit reached the server or anyone else.
    await sleep(50)
    expect(serverText('big00001').length).toBe(1_000_000)
    expect(bob.text.length).toBe(1_000_000)
    expect(bob.closeCode).toBeNull()
    expect(serverBytes('big00001')).toBeLessThanOrEqual(1024 * 1024)
  })

  it('refuses a single oversized frame outright', async () => {
    await start()
    const alice = await connect('big00002')
    const bob = await connect('big00002')

    alice.text.insert(0, 'z'.repeat(3_000_000))
    await waitFor(() => alice.closeCode !== null)
    // 1009 is the WebSocket code for "message too big".
    expect(alice.closeCode).toBe(1009)
    expect(serverText('big00002')).toBe('')
    expect(bob.closeCode).toBeNull()
  })

  it('stops a document that grows a little at a time', async () => {
    await start({ maxDocBytes: 5_000 })
    const alice = await connect('grow0001')
    const bob = await connect('grow0001')

    for (let i = 0; i < 200 && alice.closeCode === null; i++) {
      alice.text.insert(alice.text.length, 'fifty characters of text, give or take a few here\n')
      if (i % 10 === 0) await sleep(1)
    }
    await waitFor(() => alice.closeCode !== null)
    expect(alice.closeCode).toBe(CLOSE_TOO_LARGE)

    await sleep(30)
    const size = serverBytes('grow0001')
    expect(size).toBeLessThanOrEqual(5_000)
    // It filled up to within one line of the limit before refusing.
    expect(size).toBeGreaterThan(5_000 - 120)
    expect(bob.text.toString()).toBe(serverText('grow0001'))
  })

  it('still allows deleting from a full document, which makes room again', async () => {
    await start({ maxDocBytes: 5_000 })
    const alice = await connect('trim0001')
    const bob = await connect('trim0001')
    alice.text.insert(0, 'a'.repeat(4_900))
    await waitFor(() => bob.text.length === 4_900)

    // Over the limit: refused.
    const carol = await connect('trim0001')
    carol.text.insert(0, 'c'.repeat(500))
    await waitFor(() => carol.closeCode === CLOSE_TOO_LARGE)

    // Deleting is an update too, and it is accepted at the limit.
    bob.text.delete(0, 3_000)
    await waitFor(() => serverText('trim0001').length === 1_900)
    expect(bob.closeCode).toBeNull()

    bob.text.insert(0, 'b'.repeat(500))
    await waitFor(() => alice.text.length === 2_400)
    expect(bob.closeCode).toBeNull()
  })

  it('counts everything in the document, not only the text', async () => {
    await start({ maxDocBytes: 5_000 })
    const alice = await connect('meta0001')
    alice.doc.getMap('meta').set('language', 'python')
    alice.doc.getMap('meta').set('stuffing', 'm'.repeat(10_000))
    await waitFor(() => alice.closeCode !== null)
    expect(alice.closeCode).toBe(CLOSE_TOO_LARGE)
  })

  it('opens a stored document that is already over the limit', async () => {
    const storage = new MemoryStorage()
    const big = new Y.Doc()
    big.getText(TEXT_KEY).insert(0, 'q'.repeat(8_000))
    await storage.append('legacy01', Y.encodeStateAsUpdate(big), Date.now())
    await start({ storage, maxDocBytes: 5_000 })

    const alice = await connect('legacy01')
    expect(alice.text.length).toBe(8_000)
    alice.text.delete(0, 1_000)
    await waitFor(() => serverText('legacy01').length === 7_000)
    expect(alice.closeCode).toBeNull()

    alice.text.insert(0, 'more')
    await waitFor(() => alice.closeCode !== null)
    expect(alice.closeCode).toBe(CLOSE_TOO_LARGE)
  })

  it('refuses an oversized presence update', async () => {
    await start()
    const alice = await connect('aware001')
    const bob = await connect('aware001')
    alice.awareness.setLocalStateField('user', { name: 'n'.repeat(50_000) })
    await waitFor(() => alice.closeCode !== null)
    expect(alice.closeCode).toBe(CLOSE_MALFORMED)
    expect(bob.peers.size).toBe(0)
  })
})

describe('metrics', () => {
  it('reports rooms, clients and message rate', async () => {
    let now = 1_000_000_000_000
    await start({ now: () => now })
    const alice = await connect('stat0001')
    await connect('stat0001')
    await connect('stat0002')
    for (let i = 0; i < 20; i++) alice.text.insert(0, 'x')
    await waitFor(() => serverText('stat0001').length === 20)

    now += 1_000
    const metrics = (await (await fetch(`${ts.httpUrl}/metrics`)).json()) as Record<string, number>
    expect(metrics).toMatchObject({
      rooms: 2,
      clients: 3,
      uptimeSeconds: 1,
      limits: { maxUsersPerRoom: 10, maxDocBytes: 1024 * 1024 },
    })
    // 20 edits plus each client's sync handshake, all within one second.
    expect(metrics.messagesTotal).toBeGreaterThanOrEqual(23)
    expect(metrics.messagesPerSecond).toBe(Math.round(metrics.messagesTotal!) / 10)

    const health = (await (await fetch(`${ts.httpUrl}/health`)).json()) as Record<string, unknown>
    expect(health).toMatchObject({ status: 'ok', rooms: 2, clients: 3 })
    expect(health.messagesPerSecond).toBe(metrics.messagesPerSecond)

    // The rate is a moving average: it drops back once things go quiet.
    now += 20_000
    const later = (await (await fetch(`${ts.httpUrl}/metrics`)).json()) as Record<string, number>
    expect(later.messagesPerSecond).toBe(0)
    expect(later.messagesTotal).toBe(metrics.messagesTotal)
  })

  it('averages over the last 10 complete seconds', () => {
    let now = 50_000
    const metrics = new Metrics(() => now)
    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < 30; i++) metrics.recordMessage()
      now += 1_000
    }
    // 150 messages over a 10 second window.
    expect(metrics.messagesPerSecond()).toBe(15)
    for (let i = 0; i < 1000; i++) metrics.recordMessage() // current second: not counted yet
    expect(metrics.messagesPerSecond()).toBe(15)
    now += 1_000
    expect(metrics.messagesPerSecond()).toBe(115)
    now += 60_000
    expect(metrics.messagesPerSecond()).toBe(0)
    expect(metrics.messagesTotal).toBe(1150)
    expect(metrics.uptimeSeconds()).toBe(66)
  })
})

/** Storage that takes a while to load, so several connections wait on the same room. */
function slowStorage(delayMs: number): MemoryStorage {
  const storage = new MemoryStorage()
  const load = storage.load.bind(storage)
  storage.load = async (roomId) => {
    await sleep(delayMs)
    return load(roomId)
  }
  return storage
}
