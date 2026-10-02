import { parseArgs } from 'node:util'
import { createPairPadServer, type PairPadServer } from '../src/server.js'
import { formatResult, passed, runLoadTest } from './loadtest.js'

const HELP = `Load test: simulated clients type into shared rooms; reports edit latency.

Usage: npm run loadtest -- [options]

  --url <url>        Server to test, e.g. https://pairpad.example.com
                     Without it, a throwaway server is started in this process.
  --clients <n>      Total clients (default 50)
  --rooms <n>        Rooms to spread them over (default 5)
  --duration <s>     Seconds of editing (default 15)
  --rate <n>         Edits per client per second (default 2)
  --help

A room holds at most 10 people, so keep clients / rooms at 10 or below.
Against a real server the test rooms stay stored until the 7-day cleanup.
`

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    clients: { type: 'string', default: '50' },
    rooms: { type: 'string', default: '5' },
    duration: { type: 'string', default: '15' },
    rate: { type: 'string', default: '2' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

function positive(name: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive number (got "${value}")\n\n${HELP}`)
    process.exit(2)
  }
  return parsed
}

const clients = Math.floor(positive('clients', values.clients))
const rooms = Math.floor(positive('rooms', values.rooms))
const durationSeconds = positive('duration', values.duration)
const editsPerSecond = positive('rate', values.rate)

let local: PairPadServer | undefined
let httpUrl: string
if (values.url) {
  httpUrl = values.url.replace(/\/+$/, '')
} else {
  // Memory storage: this measures the sync path, not a database.
  local = createPairPadServer()
  const port = await local.listen(0, '127.0.0.1')
  httpUrl = `http://127.0.0.1:${port}`
  console.log(`Started a throwaway server on ${httpUrl} (pass --url to test a running one).`)
}
const wsUrl = `${httpUrl.replace(/^http/, 'ws')}/ws`

let exitCode = 1
try {
  const result = await runLoadTest({
    wsUrl,
    clients,
    rooms,
    durationSeconds,
    editsPerSecond,
    log: (line) => console.log(line),
  })
  console.log(formatResult(result))

  const metrics = await fetch(`${httpUrl}/metrics`)
    .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
    .catch(() => null)
  if (metrics) {
    console.log(
      `Server /metrics    ${metrics.messagesPerSecond} messages/s over the last 10 s, ${metrics.messagesTotal} in total\n`,
    )
  }

  if (passed(result)) {
    console.log('PASS: every edit reached every client and all rooms converged.')
    exitCode = 0
  } else {
    console.log('FAIL: see "Deliveries", "Disconnects" and "Rooms converged" above.')
  }
} catch (error) {
  console.error(`\nLoad test failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await local?.close()
}
process.exit(exitCode)
