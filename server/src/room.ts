import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC } from './protocol.js'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

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

  constructor(readonly id: string) {
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

  /** Applies one client frame. Throws if the frame is malformed. */
  handleMessage(conn: WebSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    switch (type) {
      case MSG_SYNC:
        this.handleSync(conn, decoder)
        break
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        )
        break
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
      case syncProtocol.messageYjsUpdate:
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(decoder), conn)
        break
      default:
        throw new Error(`unknown sync message type ${syncType}`)
    }
  }

  private onDocUpdate =(update: Uint8Array, origin: unknown): void => {
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

export class RoomManager {
  private readonly rooms = new Map<string, Room>()

  get(id: string): Room | undefined {
    return this.rooms.get(id)
  }

  getOrCreate(id: string): Room {
    let room = this.rooms.get(id)
    if (!room) {
      room = new Room(id)
      this.rooms.set(id, room)
    }
    return room
  }

  get roomCount(): number {
    return this.rooms.size
  }

  get clientCount(): number {
    let total = 0
    for (const room of this.rooms.values()) total += room.size
    return total
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) room.destroy()
    this.rooms.clear()
  }
}
