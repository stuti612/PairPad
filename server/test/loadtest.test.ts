import { afterEach, expect, it } from 'vitest'
import { passed, runLoadTest } from '../loadtest/loadtest.js'
import { startTestServer, type TestServer } from './helpers.js'

let ts: TestServer

afterEach(() => ts.server.close())

// A small, short run: checks the script itself works and measures sensibly.
// The full-size run is `npm run loadtest`.
it('measures latency for every delivery and sees the rooms converge', async () => {
  ts = await startTestServer()
  const result = await runLoadTest({
    wsUrl: ts.wsUrl,
    clients: 12,
    rooms: 3,
    durationSeconds: 1,
    editsPerSecond: 5,
  })

  expect(result.editsSent).toBeGreaterThan(12)
  // Four clients per room, so each edit goes to three others.
  expect(result.deliveriesExpected).toBe(result.editsSent * 3)
  expect(result.deliveriesReceived).toBe(result.deliveriesExpected)
  expect(result.converged).toBe(true)
  expect(result.disconnects).toBe(0)
  expect(passed(result)).toBe(true)

  const { min, p50, p95, max } = result.latencyMs
  expect(min).toBeGreaterThan(0)
  expect(min <= p50 && p50 <= p95 && p95 <= max).toBe(true)
  expect(max).toBeLessThan(2000)
})

it('reports a failure instead of hanging when a room is over its user limit', async () => {
  ts = await startTestServer({ maxUsersPerRoom: 2 })
  await expect(
    runLoadTest({ wsUrl: ts.wsUrl, clients: 4, rooms: 1, durationSeconds: 1, editsPerSecond: 1 }),
  ).rejects.toThrow(/only 2 of 4 clients connected/)
}, 30_000)
