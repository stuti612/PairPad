import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { isValidRoomId } from '../src/ids.js'
import { CLOSE_MALFORMED, TEXT_KEY } from '../src/protocol.js'
import { sleep, startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

let ts: TestServer
let clients: TestClient[]

function connect(roomId: string): Promise<TestClient> {
  const client = new TestClient(ts.wsUrl, roomId)
  clients.push(client)
  return client.ready()
}

beforeEach(async () => {
  ts = await startTestServer()
  clients = []
})

afterEach(async () => {
  for (const client of clients) client.close()
  await ts.server.close()
})

describe('room creation', () => {
  it('hands out a fresh, valid room ID per request', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${ts.httpUrl}/api/rooms`, { method: 'POST' })
      expect(res.status).toBe(201)
      const { id } = (await res.json()) as { id: string }
      expect(isValidRoomId(id)).toBe(true)
      ids.add(id)
    }
    expect(ids.size).toBe(20)
  })

  it('creates the room when the first client connects', async () => {
    expect(ts.server.rooms.roomCount).toBe(0)
    await connect('room0001')
    expect(ts.server.rooms.roomCount).toBe(1)
    expect(ts.server.rooms.get('room0001')?.size).toBe(1)
  })

  it('refuses WebSocket upgrades for invalid room IDs', async () => {
    for (const path of ['/ws/', '/ws/a', '/ws/bad%20id!', '/elsewhere/room0001']) {
      const ws = new WebSocket(`ws://127.0.0.1:${ts.port}${path}`)
      const outcome = await new Promise<string>((resolve) => {
        ws.on('open', () => resolve('open'))
        ws.on('error', () => resolve('rejected'))
      })
      expect(outcome, path).toBe('rejected')
    }
    expect(ts.server.rooms.roomCount).toBe(0)
  })

  it('reports room and client counts on /health', async () => {
    await connect('room0001')
    await connect('room0001')
    await connect('room0002')
    const res = await fetch(`${ts.httpUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', rooms: 2, clients: 3 })
  })
})

describe('document sync', () => {
  it('relays edits from one client to the other', async () => {
    const a = await connect('room0001')
    const b = await connect('room0001')

    a.text.insert(0, 'hello')
    await waitFor(() => b.text.toString() === 'hello')

    b.text.insert(5, ' world')
    await waitFor(() => a.text.toString() === 'hello world')
  })

  it('sends the existing document to a late joiner', async () => {
    const a = await connect('room0001')
    a.text.insert(0, 'already here')
    await waitFor(() => ts.server.rooms.get('room0001')?.doc.getText(TEXT_KEY).length === 12)

    const late = await connect('room0001')
    expect(late.text.toString()).toBe('already here')
  })

  it('keeps rooms isolated from each other', async () => {
    const a = await connect('room0001')
    const b = await connect('room0002')
    const a2 = await connect('room0001')

    a.text.insert(0, 'only in room one')
    await waitFor(() => a2.text.toString() === 'only in room one')
    await sleep(50)
    expect(b.text.toString()).toBe('')
  })

  it('merges concurrent edits at the same position without losing characters', async () => {
    const a = await connect('room0001')
    const b = await connect('room0001')
    a.text.insert(0, 'base')
    await waitFor(() => b.text.toString() === 'base')

    // Both edits happen in the same tick, before either side hears the other.
    a.text.insert(0, 'AAA')
    b.text.insert(0, 'BBB')

    await waitFor(() => a.text.length === 10 && b.text.length === 10)
    expect(a.text.toString()).toBe(b.text.toString())
    expect(a.text.toString()).toContain('AAA')
    expect(a.text.toString()).toContain('BBB')
    expect(a.text.toString().endsWith('base')).toBe(true)
  })

  it('converges after many interleaved inserts, keeping every character', async () => {
    const a = await connect('room0001')
    const b = await connect('room0001')
    const perClient = 150

    for (let i = 0; i < perClient; i++) {
      a.text.insert(randomIndex(a.text.length), 'a')
      b.text.insert(randomIndex(b.text.length), 'b')
      // Yield now and then so some edits cross on the wire mid-burst.
      if (i % 10 === 0) await sleep(1)
    }

    await waitFor(() => a.text.length === perClient * 2 && b.text.length === perClient * 2)
    const text = a.text.toString()
    expect(b.text.toString()).toBe(text)
    expect(count(text, 'a')).toBe(perClient)
    expect(count(text, 'b')).toBe(perClient)
    expect(ts.server.rooms.get('room0001')?.doc.getText(TEXT_KEY).toString()).toBe(text)
  })

  it('converges after interleaved inserts and deletes', async () => {
    const a = await connect('room0001')
    const b = await connect('room0001')

    for (let i = 0; i < 200; i++) {
      for (const client of [a, b]) {
        const length = client.text.length
        if (length > 5 && Math.random() < 0.3) {
          client.text.delete(randomIndex(length - 1), 1)
        } else {
          client.text.insert(randomIndex(length), String.fromCharCode(97 + (i % 26)))
        }
      }
      if (i % 10 === 0) await sleep(1)
    }
    // Frames arrive in order, so once each side sees the other's final marker
    // it has seen everything that came before it.
    a.text.insert(a.text.length, '<end-a>')
    b.text.insert(b.text.length, '<end-b>')
    const done = (c: TestClient) =>
      c.text.toString().includes('<end-a>') && c.text.toString().includes('<end-b>')
    await waitFor(() => done(a) && done(b))

    expect(a.text.toString()).toBe(b.text.toString())
    const late = await connect('room0001')
    expect(late.text.toString()).toBe(a.text.toString())
  })

  it('works with the real y-websocket provider used by the browser client', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const options = { WebSocketPolyfill: WebSocket as never, disableBc: true }
    const providerA = new WebsocketProvider(ts.wsUrl, 'room0001', docA, options)
    const providerB = new WebsocketProvider(ts.wsUrl, 'room0001', docB, options)
    try {
      await waitFor(() => providerA.synced && providerB.synced)

      docA.getText(TEXT_KEY).insert(0, 'from A. ')
      docB.getText(TEXT_KEY).insert(0, 'from B. ')
      await waitFor(
        () => docA.getText(TEXT_KEY).length === 16 && docB.getText(TEXT_KEY).length === 16,
      )
      expect(docA.getText(TEXT_KEY).toString()).toBe(docB.getText(TEXT_KEY).toString())

      providerA.awareness.setLocalStateField('user', { name: 'Ada' })
      await waitFor(
        () =>
          (providerB.awareness.getStates().get(docA.clientID) as { user?: { name: string } })
            ?.user?.name === 'Ada',
      )
    } finally {
      providerA.destroy()
      providerB.destroy()
    }
  })
})

describe('awareness', () => {
  it('shares presence between clients and clears it on disconnect', async () => {
    const a = await connect('room0001')
    const b = await connect('room0001')

    a.awareness.setLocalStateField('user', { name: 'Ada', color: '#f00' })
    await waitFor(() => b.peers.get(a.doc.clientID)?.user !== undefined)
    expect(b.peers.get(a.doc.clientID)?.user).toEqual({ name: 'Ada', color: '#f00' })

    // Someone joining later still sees who is already there.
    const c = await connect('room0001')
    await waitFor(() => c.peers.has(a.doc.clientID))

    a.ws.terminate()
    await waitFor(() => !b.peers.has(a.doc.clientID) && !c.peers.has(a.doc.clientID))
    expect(ts.server.rooms.get('room0001')?.size).toBe(2)
  })
})

describe('malformed messages', () => {
  it.each([
    ['an unknown message type', new Uint8Array([42, 1, 2, 3])],
    ['an unknown sync sub-type', new Uint8Array([0, 99])],
    ['a truncated sync update', new Uint8Array([0, 2, 200])],
    ['a sync update with a garbage body', new Uint8Array([0, 2, 4, 255, 255, 255, 255])],
    ['a truncated awareness update', new Uint8Array([1, 50, 1])],
    ['an empty frame', new Uint8Array([])],
    ['a text frame', 'hello'],
  ])('closes the connection on %s', async (_name, frame) => {
    const bad = await connect('room0001')
    const good = await connect('room0001')

    bad.sendRaw(frame)
    await waitFor(() => bad.closeCode !== null)
    expect(bad.closeCode).toBe(CLOSE_MALFORMED)

    // The server and the other client carry on.
    good.text.insert(0, 'still working')
    const late = await connect('room0001')
    await waitFor(() => late.text.toString() === 'still working')
  })
})

function randomIndex(length: number): number {
  return Math.floor(Math.random() * (length + 1))
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}
