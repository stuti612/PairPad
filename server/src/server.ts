import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateRoomId, isValidRoomId } from './ids.js'
import { CLOSE_LOAD_FAILED, CLOSE_MALFORMED } from './protocol.js'
import { Room, RoomManager } from './room.js'
import { serveStatic } from './static.js'
import { MemoryStorage } from './storage/memory.js'
import type { RoomStorage } from './storage/types.js'

const WS_PATH_PREFIX = '/ws/'
const HEARTBEAT_INTERVAL_MS = 30_000
// Frames a client may send while its room is still loading from storage.
const MAX_BACKLOG_FRAMES = 64
const DAY_MS = 24 * 60 * 60 * 1000

export interface PairPadServerOptions {
  /** Directory holding the built frontend. Omit to run as an API-only server. */
  staticDir?: string
  /** Where rooms are saved. Defaults to memory only. The server closes it on shutdown. */
  storage?: RoomStorage
  /** How long edits are batched before being written. */
  flushMs?: number
  /** Stored rows per room before they are squashed into one snapshot. */
  compactAfter?: number
  /** How long to wait before retrying a failed write. */
  retryMs?: number
  /** How long an empty room stays in memory before it is saved and unloaded. */
  idleUnloadMs?: number
  /** Rooms unused for this long are deleted. */
  roomTtlMs?: number
  /** How often to look for rooms to delete. */
  cleanupIntervalMs?: number
  /** Clock, replaceable in tests. */
  now?: () => number
  onError?: (error: unknown, context: string) => void
}

export interface PairPadServer {
  readonly rooms: RoomManager
  /** Starts listening and resolves with the bound port (pass 0 for a random one). */
  listen(port: number, host?: string): Promise<number>
  /** Deletes rooms unused for longer than the TTL and returns their IDs. Also runs on a timer. */
  cleanup(): Promise<string[]>
  /** Saves every room and stops the server. */
  close(): Promise<void>
}

export function createPairPadServer(options: PairPadServerOptions = {}): PairPadServer {
  const {
    staticDir,
    storage = new MemoryStorage(),
    roomTtlMs = 7 * DAY_MS,
    cleanupIntervalMs = 60 * 60 * 1000,
    onError = (error, context) => console.error(`Error ${context}:`, error),
  } = options

  const rooms = new RoomManager({
    storage,
    flushMs: options.flushMs ?? 300,
    compactAfter: options.compactAfter ?? 100,
    retryMs: options.retryMs ?? 2000,
    idleUnloadMs: options.idleUnloadMs ?? 30_000,
    now: options.now ?? Date.now,
    onError,
  })
  const wss = new WebSocketServer({ noServer: true })
  const alive = new WeakMap<WebSocket, boolean>()
  let cleanupTimer: NodeJS.Timeout | null = null

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (res.headersSent) res.destroy()
      else sendJson(res, 500, { error: 'internal error' })
    })
  })

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
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
    const isPage = req.method === 'GET' || req.method === 'HEAD'
    const reserved = pathname.startsWith('/api/') || pathname.startsWith(WS_PATH_PREFIX)
    if (staticDir && isPage && !reserved && (await serveStatic(staticDir, pathname, req, res))) {
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

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
    alive.set(conn, true)
    // The socket is open before the room has loaded from storage, so frames
    // that arrive in the meantime wait here and are replayed in order.
    let room: Room | null = null
    const backlog: Uint8Array[] = []

    const handle = (target: Room, data: Uint8Array): void => {
      try {
        target.handleMessage(conn, data)
      } catch {
        conn.close(CLOSE_MALFORMED, 'malformed message')
      }
    }

    conn.on('pong', () => alive.set(conn, true))
    conn.on('message', (data, isBinary) => {
      if (!isBinary) {
        conn.close(CLOSE_MALFORMED, 'binary frames only')
        return
      }
      const bytes = toUint8Array(data as Buffer)
      if (room) {
        handle(room, bytes)
      } else if (backlog.length < MAX_BACKLOG_FRAMES) {
        backlog.push(bytes)
      } else {
        conn.close(CLOSE_MALFORMED, 'too many messages before sync')
      }
    })
    conn.on('close', () => {
      if (!room) return
      room.removeConnection(conn)
      rooms.release(room)
    })
    conn.on('error', () => conn.terminate())

    rooms.acquire(roomId).then(
      (loaded) => {
        if (conn.readyState !== WebSocket.OPEN) {
          // The client gave up while the room was loading.
          rooms.release(loaded)
          return
        }
        room = loaded
        loaded.addConnection(conn)
        for (const bytes of backlog) handle(loaded, bytes)
        backlog.length = 0
      },
      (error) => {
        onError(error, `loading room ${roomId}`)
        // The client's provider retries with backoff, which suits a database blip.
        conn.close(CLOSE_LOAD_FAILED, 'could not load room')
      },
    )
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

  async function cleanup(): Promise<string[]> {
    try {
      return await rooms.deleteInactive(roomTtlMs)
    } catch (error) {
      onError(error, 'deleting inactive rooms')
      return []
    }
  }

  return {
    rooms,
    cleanup,
    async listen(port, host) {
      await storage.init()
      void cleanup()
      cleanupTimer = setInterval(() => void cleanup(), cleanupIntervalMs)
      cleanupTimer.unref()
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject)
          resolve((httpServer.address() as AddressInfo).port)
        })
      })
    },
    async close() {
      clearInterval(heartbeat)
      if (cleanupTimer) clearInterval(cleanupTimer)
      for (const conn of wss.clients) conn.terminate()
      wss.close()
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        httpServer.closeAllConnections()
      })
      // Every room gets its final save before the database connection closes.
      await rooms.closeAll()
      await storage.close()
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
