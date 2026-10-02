import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateRoomId, isValidRoomId } from './ids.js'
import { CLOSE_MALFORMED } from './protocol.js'
import { RoomManager } from './room.js'

const WS_PATH_PREFIX = '/ws/'
const HEARTBEAT_INTERVAL_MS = 30_000

export interface PairPadServer {
  readonly rooms: RoomManager
  /** Starts listening and resolves with the bound port (pass 0 for a random one). */
  listen(port: number, host?: string): Promise<number>
  close(): Promise<void>
}

export function createPairPadServer(): PairPadServer {
  const rooms = new RoomManager()
  const wss = new WebSocketServer({ noServer: true })
  const alive = new WeakMap<WebSocket, boolean>()

  const httpServer = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'POST' && pathname === '/api/rooms') {
      // Rooms are created lazily on first connect; this only hands out an ID.
      return sendJson(res, 201, { id: generateRoomId() })
    }
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        rooms: rooms.roomCount,
        clients: rooms.clientCount,
      })
    }
    sendJson(res, 404, { error: 'not found' })
  })

  httpServer.on('upgrade', (req, socket, head) => {
    const roomId = roomIdFromUrl(req.url)
    if (!roomId) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (conn) => onConnection(conn, roomId))
  })

  function onConnection(conn: WebSocket, roomId: string): void {
    const room = rooms.getOrCreate(roomId)
    alive.set(conn, true)

    conn.on('pong', () => alive.set(conn, true))
    conn.on('message', (data, isBinary) => {
      if (!isBinary) {
        conn.close(CLOSE_MALFORMED, 'binary frames only')
        return
      }
      try {
        room.handleMessage(conn, toUint8Array(data as Buffer))
      } catch {
        conn.close(CLOSE_MALFORMED, 'malformed message')
      }
    })
    conn.on('close', () => room.removeConnection(conn))
    conn.on('error', () => conn.terminate())

    room.addConnection(conn)
  }

  // Drop connections that stopped answering pings (e.g. laptop lid closed).
  const heartbeat = setInterval(() => {
    for (const conn of wss.clients) {
      if (alive.get(conn) === false) {
        conn.terminate()
        continue
      }
      alive.set(conn, false)
      conn.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  return {
    rooms,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject)
          resolve((httpServer.address() as AddressInfo).port)
        })
      })
    },
    close() {
      clearInterval(heartbeat)
      for (const conn of wss.clients) conn.terminate()
      wss.close()
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          rooms.destroyAll()
          if (err) reject(err)
          else resolve()
        })
        httpServer.closeAllConnections()
      })
    },
  }
}

function roomIdFromUrl(url: string | undefined): string | null {
  const { pathname } = new URL(url ?? '/', 'http://localhost')
  if (!pathname.startsWith(WS_PATH_PREFIX)) return null
  const id = pathname.slice(WS_PATH_PREFIX.length)
  return isValidRoomId(id) ? id : null
}

function toUint8Array(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
