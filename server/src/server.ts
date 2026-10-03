import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateRoomId, isValidRoomId } from './ids.js'
import { AiError } from './ai/llm.js'
import type { AiService } from './ai/service.js'
import { SuggestionError } from './ai/suggestions.js'
import { Metrics } from './metrics.js'
import {
  CLOSE_LOAD_FAILED,
  CLOSE_MALFORMED,
  CLOSE_ROOM_FULL,
  CLOSE_TOO_LARGE,
} from './protocol.js'
import { DocTooLargeError, Room, RoomManager } from './room.js'
import { serveStatic } from './static.js'
import { MemoryStorage } from './storage/memory.js'
import type { RoomStorage } from './storage/types.js'

const WS_PATH_PREFIX = '/ws/'
const HEARTBEAT_INTERVAL_MS = 30_000
// Frames a client may send while its room is still loading from storage.
const MAX_BACKLOG_FRAMES = 64
const DAY_MS = 24 * 60 * 60 * 1000
// Room for the sync framing around a document that is itself at the limit.
const FRAME_OVERHEAD_BYTES = 64 * 1024

export const DEFAULT_MAX_USERS_PER_ROOM = 10
export const DEFAULT_MAX_DOC_BYTES = 1024 * 1024

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
  /** The AI collaborator, or null/omitted when no provider is configured. */
  ai?: AiService | null
  /** People allowed in one room at a time. */
  maxUsersPerRoom?: number
  /** Largest allowed document, measured as its encoded Yjs state in bytes. */
  maxDocBytes?: number
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
    ai = null,
    maxUsersPerRoom = DEFAULT_MAX_USERS_PER_ROOM,
    maxDocBytes = DEFAULT_MAX_DOC_BYTES,
    now = Date.now,
  } = options
  const metrics = new Metrics(now)

  const rooms = new RoomManager({
    storage,
    flushMs: options.flushMs ?? 300,
    compactAfter: options.compactAfter ?? 100,
    retryMs: options.retryMs ?? 2000,
    idleUnloadMs: options.idleUnloadMs ?? 30_000,
    maxDocBytes,
    now,
    onError,
    onRoomLoaded: ai ? (room) => ai.attach(room) : undefined,
  })
  // ws itself refuses any single frame bigger than a full document could need.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxDocBytes + FRAME_OVERHEAD_BYTES,
  })
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
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/metrics')) {
      const snapshot = {
        rooms: rooms.roomCount,
        clients: rooms.clientCount,
        messagesPerSecond: metrics.messagesPerSecond(),
      }
      if (pathname === '/health') return sendJson(res, 200, { status: 'ok', ...snapshot })
      return sendJson(res, 200, {
        ...snapshot,
        messagesTotal: metrics.messagesTotal,
        uptimeSeconds: metrics.uptimeSeconds(),
        limits: { maxUsersPerRoom, maxDocBytes },
      })
    }
    const aiRoute = AI_ROUTE.exec(pathname)
    if (aiRoute) return handleAi(req, res, aiRoute[1]!)
    const decision = DECISION_ROUTE.exec(pathname)
    if (decision) {
      return handleDecision(req, res, decision[1]!, decision[2]!, decision[3] as 'accept' | 'reject')
    }

    const isPage = req.method === 'GET' || req.method === 'HEAD'
    const reserved = pathname.startsWith('/api/') || pathname.startsWith(WS_PATH_PREFIX)
    if (staticDir && isPage && !reserved && (await serveStatic(staticDir, pathname, req, res))) {
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  // GET: whether the AI is available here, and how many requests are left.
  // POST: ask it for a suggestion. Keys and provider details never leave the server.
  async function handleAi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    roomId: string,
  ): Promise<void> {
    if (!isValidRoomId(roomId)) return sendJson(res, 404, { error: 'not found' })
    if (req.method === 'GET') {
      if (!ai) return sendJson(res, 200, { enabled: false })
      return sendJson(res, 200, {
        enabled: true,
        provider: ai.label,
        busy: ai.isBusy(roomId),
        quota: ai.quotaFor(roomId),
      })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (!ai) return sendJson(res, 503, { error: 'The AI collaborator is not set up on this server.' })

    const room = rooms.get(roomId)
    if (!room) return sendJson(res, 409, { error: 'Open the pad before asking the AI.' })

    let body: unknown
    try {
      body = await readJson(req, MAX_AI_BODY_BYTES)
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 400
      return sendJson(res, status, {
        error: status === 413 ? 'The request is too large.' : 'The request was not valid JSON.',
      })
    }

    // Everyone may leave while the AI works; the room must outlive the request.
    const release = rooms.hold(room)
    try {
      const suggestion = ai.start(room, body, release)
      sendJson(res, 202, { id: suggestion.id, quota: ai.quotaFor(roomId) })
    } catch (error) {
      release()
      const failure =
        error instanceof AiError ? error : new AiError('The AI request failed unexpectedly.', 'unavailable')
      if (!(error instanceof AiError)) onError(error, `AI request in room ${roomId}`)
      sendJson(res, failure.status, { error: failure.message, quota: ai.quotaFor(roomId) })
    }
  }

  // Accept or reject a suggestion. Done here on the server, not by clients
  // editing shared state, so a suggestion is applied exactly once.
  async function handleDecision(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    roomId: string,
    suggestionId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    const room = isValidRoomId(roomId) ? rooms.get(roomId) : undefined
    if (!ai || !room) return sendJson(res, 404, { error: 'That suggestion does not exist.' })
    let body: Record<string, unknown> = {}
    try {
      body = ((await readJson(req, MAX_AI_BODY_BYTES)) ?? {}) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'The request was not valid JSON.' })
    }
    try {
      const by = typeof body.by === 'string' ? body.by : ''
      const suggestion =
        action === 'accept' ? ai.accept(room, suggestionId, by) : ai.reject(room, suggestionId, by)
      sendJson(res, 200, { status: suggestion.status })
    } catch (error) {
      if (error instanceof SuggestionError) {
        return sendJson(res, error.status, { error: error.message })
      }
      onError(error, `${action} in room ${roomId}`)
      sendJson(res, 500, { error: 'internal error' })
    }
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
      } catch (error) {
        if (error instanceof DocTooLargeError) conn.close(CLOSE_TOO_LARGE, 'document too large')
        else conn.close(CLOSE_MALFORMED, 'malformed message')
      }
    }

    conn.on('pong', () => alive.set(conn, true))
    conn.on('message', (data, isBinary) => {
      metrics.recordMessage()
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
    // ws has already started a proper close (e.g. 1009 for an oversized
    // frame) by the time it reports an error; only force it if it has not.
    conn.on('error', () => {
      if (conn.readyState === WebSocket.OPEN) conn.terminate()
    })

    rooms.acquire(roomId).then(
      (loaded) => {
        if (conn.readyState !== WebSocket.OPEN) {
          // The client gave up while the room was loading.
          rooms.release(loaded)
          return
        }
        if (loaded.size >= maxUsersPerRoom) {
          conn.close(CLOSE_ROOM_FULL, 'room full')
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
      // Running AI requests end first, so their outcome is saved with the room.
      await ai?.shutdown()
      // Every room gets its final save before the database connection closes.
      await rooms.closeAll()
      await storage.close()
    },
  }
}

const AI_ROUTE = /^\/api\/rooms\/([^/]+)\/ai$/
const DECISION_ROUTE = /^\/api\/rooms\/([^/]+)\/suggestions\/([0-9a-f]{1,32})\/(accept|reject)$/
const MAX_AI_BODY_BYTES = 16 * 1024

class BodyTooLargeError extends Error {}

function readJson(req: http.IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limitBytes) {
        // Keep reading and discarding the rest, so the 413 can still be sent.
        tooLarge = true
        chunks.length = 0
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
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
