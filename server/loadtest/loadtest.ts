import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { TEXT_KEY } from '../src/protocol.js'

export interface LoadTestOptions {
  /** WebSocket base URL, e.g. ws://localhost:3001/ws */
  wsUrl: string
  /** Total simulated clients, spread evenly over the rooms. */
  clients: number
  rooms: number
  /** How long clients keep editing, in seconds. */
  durationSeconds: number
  /** Edits each client makes per second. */
  editsPerSecond: number
  log?: (line: string) => void
}

export interface LoadTestResult {
  clients: number
  rooms: number
  editsSent: number
  /** Each edit should reach every other client in its room. */
  deliveriesExpected: number
  deliveriesReceived: number
  /** Milliseconds from an edit being made to another client applying it. */
  latencyMs: { min: number; mean: number; p50: number; p95: number; p99: number; max: number }
  /** True when every client in every room ended with identical text. */
  converged: boolean
  disconnects: number
  elapsedSeconds: number
}

interface Client {
  roomIndex: number
  doc: Y.Doc
  provider: WebsocketProvider
  text: Y.Text
}

const CONNECT_TIMEOUT_MS = 20_000
const DRAIN_TIMEOUT_MS = 10_000

/**
 * Opens simulated clients that type into shared rooms and measures how long
 * each edit takes to reach the other clients in the same room.
 *
 * Every inserted character has a unique Yjs ID (client ID + clock). The
 * sender notes the time against that ID; each receiver looks the ID up when
 * its copy of the document advances past it. All clients run in this process, so they share one
 * clock and the measurement needs no clock sync.
 */
export async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const { wsUrl, rooms, durationSeconds, editsPerSecond, log = () => {} } = options
  const total = options.clients
  const runId = randomBytes(4).toString('hex')
  const roomIds = Array.from({ length: rooms }, (_, i) => `load${runId}${i}`)

  const sentAt = new Map<string, number>()
  const latencies: number[] = []
  let editsSent = 0
  let deliveriesExpected = 0
  let disconnects = 0
  let running = false

  const clients: Client[] = []
  const roomSizes = roomIds.map(() => 0)

  // Each provider registers a process "exit" listener; lift Node's default
  // cap of 10 so that does not print a leak warning.
  process.setMaxListeners(Math.max(process.getMaxListeners(), total + 10))

  log(`Connecting ${total} clients across ${rooms} rooms at ${wsUrl} ...`)
  for (let i = 0; i < total; i++) {
    const roomIndex = i % rooms
    roomSizes[roomIndex]!++
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(wsUrl, roomIds[roomIndex]!, doc, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    })
    provider.awareness.setLocalStateField('user', { name: `load-${i}`, color: '#60a5fa' })
    const text = doc.getText(TEXT_KEY)

    doc.on('afterTransaction', (transaction) => {
      if (transaction.local) return
      const now = performance.now()
      // The state vector says how far each client's clock moved in this
      // transaction; every step is one character that just arrived.
      for (const [clientId, after] of transaction.afterState) {
        const before = transaction.beforeState.get(clientId) ?? 0
        for (let clock = before; clock < after; clock++) {
          const sent = sentAt.get(`${clientId}:${clock}`)
          if (sent !== undefined) latencies.push(now - sent)
        }
      }
    })
    provider.on('status', ({ status }) => {
      if (running && status === 'disconnected') disconnects++
    })
    clients.push({ roomIndex, doc, provider, text })
  }

  try {
    await waitUntil(
      () => clients.every((client) => client.provider.synced),
      CONNECT_TIMEOUT_MS,
      () => {
        const ready = clients.filter((client) => client.provider.synced).length
        return `only ${ready} of ${total} clients connected (is the server running, and is each room within its user limit?)`
      },
    )
    log(`All ${total} clients connected. Editing for ${durationSeconds}s ...`)

    running = true
    const started = performance.now()
    const intervalMs = 1000 / editsPerSecond
    const timers = clients.map((client) => {
      const edit = () => {
        const index = Math.floor(Math.random() * (client.text.length + 1))
        // The next insert by this client gets the ID (clientID, current clock).
        const clock = Y.getState(client.doc.store, client.doc.clientID)
        sentAt.set(`${client.doc.clientID}:${clock}`, performance.now())
        client.text.insert(index, 'x')
        // A real editor also sends a cursor update with every keystroke.
        client.provider.awareness.setLocalStateField('cursor', { index })
        editsSent++
        deliveriesExpected += roomSizes[client.roomIndex]! - 1
      }
      // Spread clients out so they do not all fire in the same instant.
      let interval: NodeJS.Timeout | undefined
      const start = setTimeout(() => {
        edit()
        interval = setInterval(edit, intervalMs)
      }, Math.random() * intervalMs)
      return () => {
        clearTimeout(start)
        clearInterval(interval)
      }
    })

    await sleep(durationSeconds * 1000)
    for (const stop of timers) stop()
    const elapsedSeconds = (performance.now() - started) / 1000

    // Give the last edits time to arrive everywhere.
    await waitUntil(() => latencies.length >= deliveriesExpected, DRAIN_TIMEOUT_MS).catch(() => {})
    running = false

    const converged = roomIds.every((_, roomIndex) => {
      const texts = clients
        .filter((client) => client.roomIndex === roomIndex)
        .map((client) => client.text.toString())
      return texts.every((value) => value === texts[0])
    })

    return {
      clients: total,
      rooms,
      editsSent,
      deliveriesExpected,
      deliveriesReceived: latencies.length,
      latencyMs: summarise(latencies),
      converged,
      disconnects,
      elapsedSeconds,
    }
  } finally {
    for (const client of clients) {
      client.provider.destroy()
      client.doc.destroy()
    }
  }
}

function summarise(values: number[]): LoadTestResult['latencyMs'] {
  if (values.length === 0) return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
  return {
    min: sorted[0]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  }
}

export function formatResult(result: LoadTestResult): string {
  const ms = (value: number) => `${value.toFixed(1)} ms`
  const { latencyMs: latency } = result
  const delivered = `${result.deliveriesReceived} of ${result.deliveriesExpected}`
  return [
    '',
    `Clients            ${result.clients} across ${result.rooms} rooms`,
    `Duration           ${result.elapsedSeconds.toFixed(1)} s`,
    `Edits sent         ${result.editsSent} (${(result.editsSent / result.elapsedSeconds).toFixed(0)} per second)`,
    `Deliveries         ${delivered}`,
    `Disconnects        ${result.disconnects}`,
    `Rooms converged    ${result.converged ? 'yes' : 'NO'}`,
    '',
    'Latency, from an edit to another client applying it:',
    `  min   ${ms(latency.min)}`,
    `  mean  ${ms(latency.mean)}`,
    `  p50   ${ms(latency.p50)}`,
    `  p95   ${ms(latency.p95)}`,
    `  p99   ${ms(latency.p99)}`,
    `  max   ${ms(latency.max)}`,
    '',
  ].join('\n')
}

/** A run passes when nothing was lost, nobody was dropped, and every room agrees. */
export function passed(result: LoadTestResult): boolean {
  return (
    result.converged &&
    result.disconnects === 0 &&
    result.deliveriesExpected > 0 &&
    result.deliveriesReceived === result.deliveriesExpected
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  describe: () => string = () => 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`)
    await sleep(20)
  }
}
