import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { RoomPersistence, type PersistenceOptions } from './persistence.js'
import { MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC } from './protocol.js'
import type { RoomStorage } from './storage/types.js'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

/** Thrown when an update would take a document past the size limit. */
export class DocTooLargeError extends Error {
  constructor() {
    super('document size limit reached')
  }
}

// Presence is a name, a color and a cursor; anything much bigger is abuse.
const MAX_AWARENESS_BYTES = 16 * 1024

/**
 * One pad: the authoritative Y.Doc, its awareness (presence) state, and the
 * sockets currently attached to it.
 */
export class Room {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  // Each connection maps to the awareness client IDs it announced, so their
  // presence can be cleared when the socket goes away.
  private readonly conns = new Map<WebSocket, Set<number>>()
  /** Server-side work (such as an AI request) keeping the room in memory. */
  holds = 0
  // Upper estimate of the encoded document size, so the exact (and slower)
  // measurement only happens when a room is actually close to the limit.
  private sizeEstimate = 0

  constructor(
    readonly id: string,
    /** Largest allowed encoded document, in bytes. */
    private readonly maxDocBytes: number = Infinity,
  ) {
    // The server is not a participant, so it has no presence of its own.
    this.awareness.setLocalState(null)
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  get size(): number {
    return this.conns.size
  }

  addConnection(conn: WebSocket): void {
    this.conns.set(conn, new Set())

    // Sync step 1: tell the client what we have so it replies with what we lack.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.send(conn, encoding.toUint8Array(encoder))

    this.sendAwarenessStates(conn)
  }

  removeConnection(conn: WebSocket): void {
    const clientIds = this.conns.get(conn)
    if (!clientIds) return
    this.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...clientIds], null)
  }

  /** Applies an update read from storage. Stored data is never refused for size. */
  applyStored(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, 'storage')
    this.sizeEstimate += update.byteLength
  }

  /**
   * Applies one client frame. Throws DocTooLargeError if it would take the
   * document past the size limit, or another error if the frame is malformed.
   */
  handleMessage(conn: WebSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    switch (type) {
      case MSG_SYNC:
        this.handleSync(conn, decoder)
        break
      case MSG_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder)
        if (update.byteLength > MAX_AWARENESS_BYTES) throw new Error('presence update too large')
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn)
        break
      }
      case MSG_QUERY_AWARENESS:
        this.sendAwarenessStates(conn)
        break
      default:
        throw new Error(`unknown message type ${type}`)
    }
  }

  destroy(): void {
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    this.conns.clear()
    this.awareness.destroy()
    this.doc.destroy()
  }

  // Decoded by hand rather than with syncProtocol.readSyncMessage, which
  // catches and logs bad updates instead of letting us reject the sender.
  private handleSync(conn: WebSocket, decoder: decoding.Decoder): void {
    const syncType = decoding.readVarUint(decoder)
    switch (syncType) {
      case syncProtocol.messageYjsSyncStep1: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.readSyncStep1(decoder, encoder, this.doc)
        this.send(conn, encoding.toUint8Array(encoder))
        break
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const update = decoding.readVarUint8Array(decoder)
        this.assertFits(update)
        Y.applyUpdate(this.doc, update, conn)
        break
      }
      default:
        throw new Error(`unknown sync message type ${syncType}`)
    }
  }

  /**
   * The limit is on the encoded document: the text plus the CRDT's own
   * bookkeeping, which is what gets stored and sent to everyone who joins.
   * A Yjs update cannot be undone once applied, so the check comes first.
   */
  private assertFits(update: Uint8Array): void {
    // Applying an update grows the document by at most about its own size.
    if (this.sizeEstimate + update.byteLength <= this.maxDocBytes) {
      this.sizeEstimate += update.byteLength
      return
    }
    // The estimate only ever overshoots (it ignores deletions), so measure.
    const state = Y.encodeStateAsUpdate(this.doc)
    this.sizeEstimate = state.byteLength
    if (state.byteLength + update.byteLength <= this.maxDocBytes) {
      this.sizeEstimate += update.byteLength
      return
    }
    // Genuinely close to the limit: try the update on a copy. Updates that
    // shrink the document (deleting text) are always allowed, so a full pad
    // can be brought back under the limit.
    const trial = new Y.Doc()
    try {
      Y.applyUpdate(trial, state)
      Y.applyUpdate(trial, update)
      const after = Y.encodeStateAsUpdate(trial).byteLength
      if (after > this.maxDocBytes && after > state.byteLength) throw new DocTooLargeError()
      this.sizeEstimate = after
    } finally {
      trial.destroy()
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this.broadcast(encoding.toUint8Array(encoder), origin)
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: AwarenessChange,
    origin: unknown,
  ): void => {
    const controlled = this.conns.get(origin as WebSocket)
    if (controlled) {
      for (const id of added) controlled.add(id)
      for (const id of removed) controlled.delete(id)
    }
    const changed = [...added, ...updated, ...removed]
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    )
    this.broadcast(encoding.toUint8Array(encoder), origin)
  }

  private sendAwarenessStates(conn: WebSocket): void {
    const states = this.awareness.getStates()
    if (states.size === 0) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
    )
    this.send(conn, encoding.toUint8Array(encoder))
  }

  // The sender already has its own change, so it is skipped.
  private broadcast(message: Uint8Array, except: unknown): void {
    for (const conn of this.conns.keys()) {
      if (conn !== except) this.send(conn, message)
    }
  }

  private send(conn: WebSocket, message: Uint8Array): void {
    if (conn.readyState !== WebSocket.OPEN) return
    conn.send(message, (err) => {
      if (err) conn.terminate()
    })
  }
}

interface Entry {
  room: Room
  persistence: RoomPersistence
  idleTimer: NodeJS.Timeout | null
}

export interface RoomManagerOptions extends PersistenceOptions {
  storage: RoomStorage
  /** How long an empty room stays in memory before it is saved and unloaded. */
  idleUnloadMs: number
  /** Largest allowed encoded document, in bytes. */
  maxDocBytes: number
}

/**
 * Owns the rooms that are currently in memory: loads them from storage on
 * first use, saves them as they change, and unloads them once empty.
 */
export class RoomManager {
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<Room>>()
  private readonly unloading = new Map<string, Promise<void>>()

  constructor(private readonly options: RoomManagerOptions) {}

  get(id: string): Room | undefined {
    return this.entries.get(id)?.room
  }

  /**
   * Returns the room, loading it from storage if needed. The caller must
   * follow up with either room.addConnection() or release().
   */
  acquire(id: string): Promise<Room> {
    const entry = this.entries.get(id)
    if (entry) {
      this.cancelIdle(entry)
      return Promise.resolve(entry.room)
    }
    // Everyone who arrives while the room is loading shares the same load.
    let loading = this.loading.get(id)
    if (!loading) {
      loading = this.load(id).finally(() => this.loading.delete(id))
      this.loading.set(id, loading)
    }
    return loading
  }

  /** Call after a connection leaves; an empty room is unloaded after a grace period. */
  release(room: Room): void {
    const entry = this.entries.get(room.id)
    if (!entry || entry.room !== room || !isIdle(room) || entry.idleTimer) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (isIdle(room)) void this.unload(room.id)
    }, this.options.idleUnloadMs)
    entry.idleTimer.unref()
  }

  /**
   * Keeps a loaded room in memory while server-side work runs, even if
   * everyone leaves. Call the returned function when the work is done.
   */
  hold(room: Room): () => void {
    room.holds++
    const entry = this.entries.get(room.id)
    if (entry) this.cancelIdle(entry)
    let released = false
    return () => {
      if (released) return
      released = true
      room.holds--
      this.release(room)
    }
  }

  /** Writes any buffered edits for every room in memory. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.persistence.flush()))
  }

  /** Deletes rooms nobody has used for `ttlMs`. Rooms with people in them always survive. */
  async deleteInactive(ttlMs: number): Promise<string[]> {
    const now = this.options.now()
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.room.size > 0)
        .map((entry) => this.options.storage.touch(entry.room.id, now)),
    )
    return this.options.storage.deleteInactive(now - ttlMs)
  }

  get roomCount(): number {
    return this.entries.size
  }

  get clientCount(): number {
    let total = 0
    for (const { room } of this.entries.values()) total += room.size
    return total
  }

  /** Saves and unloads everything, for shutdown. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(this.loading.values())
    for (const id of [...this.entries.keys()]) void this.unload(id)
    await Promise.all(this.unloading.values())
  }

  private async load(id: string): Promise<Room> {
    // If this room is mid-way through its final save, wait so we read all of it.
    await this.unloading.get(id)
    const { storage, now, onError } = this.options
    const updates = await storage.load(id)

    const room = new Room(id, this.options.maxDocBytes)
    for (const update of updates) {
      try {
        room.applyStored(update)
      } catch (error) {
        // One unreadable row should not make the whole room unopenable.
        onError(error, `reading a stored update for room ${id}`)
      }
    }
    // Attached after loading so stored updates are not written back again.
    const persistence = new RoomPersistence(id, room.doc, storage, updates.length, this.options)
    this.entries.set(id, { room, persistence, idleTimer: null })
    if (updates.length > 0) {
      storage.touch(id, now()).catch((error) => onError(error, `touching room ${id}`))
    }
    return room
  }

  private unload(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return this.unloading.get(id) ?? Promise.resolve()
    this.cancelIdle(entry)
    this.entries.delete(id)
    const done = entry.persistence
      .close()
      .then(() => entry.room.destroy())
      .finally(() => {
        if (this.unloading.get(id) === done) this.unloading.delete(id)
      })
    this.unloading.set(id, done)
    return done
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

function isIdle(room: Room): boolean {
  return room.size === 0 && room.holds === 0
}
