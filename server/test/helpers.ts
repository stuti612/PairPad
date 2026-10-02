import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { MSG_AWARENESS, MSG_SYNC, TEXT_KEY } from '../src/protocol.js'
import {
  createPairPadServer,
  type PairPadServer,
  type PairPadServerOptions,
} from '../src/server.js'

export interface TestServer {
  server: PairPadServer
  port: number
  httpUrl: string
  wsUrl: string
}

export async function startTestServer(options: PairPadServerOptions = {}): Promise<TestServer> {
  const server = createPairPadServer(options)
  const port = await server.listen(0, '127.0.0.1')
  return {
    server,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  }
}

/** A minimal Yjs client speaking the same wire protocol as the browser. */
export class TestClient {
  readonly awareness: awarenessProtocol.Awareness
  readonly ws: WebSocket
  synced = false
  closeCode: number | null = null

  /** Pass an existing doc to simulate a client reconnecting with its local copy. */
  constructor(
    wsUrl: string,
    roomId: string,
    readonly doc: Y.Doc = new Y.Doc(),
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc)
    this.ws = new WebSocket(`${wsUrl}/${roomId}`)
    this.ws.binaryType = 'nodebuffer'

    this.ws.on('open', () => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.ws.send(encoding.toUint8Array(encoder))
    })
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)))
    this.ws.on('close', (code) => {
      this.closeCode = code
    })
    this.ws.on('error', () => {})

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.sendRaw(encoding.toUint8Array(encoder))
    })
    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === this) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            ...added,
            ...updated,
            ...removed,
          ]),
        )
        this.sendRaw(encoding.toUint8Array(encoder))
      },
    )
  }

  get text(): Y.Text {
    return this.doc.getText(TEXT_KEY)
  }

  /** Awareness states of everyone else in the room, keyed by client ID. */
  get peers(): Map<number, Record<string, unknown>> {
    const peers = new Map(this.awareness.getStates())
    peers.delete(this.doc.clientID)
    return peers
  }

  sendRaw(data: Uint8Array | string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  async ready(): Promise<this> {
    await waitFor(() => this.synced)
    return this
  }

  close(): void {
    this.awareness.destroy()
    this.ws.close()
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MSG_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (syncType === syncProtocol.messageYjsSyncStep2) this.synced = true
      if (encoding.length(encoder) > 1) this.sendRaw(encoding.toUint8Array(encoder))
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      )
    }
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  message = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await sleep(5)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
