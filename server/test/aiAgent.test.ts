import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BUSY_MESSAGE, AiError } from '../src/ai/llm.js'
import { AI_COLOR, AI_NAME } from '../src/ai/presence.js'
import { AiService } from '../src/ai/service.js'
import type { PairPadServerOptions } from '../src/server.js'
import { deferred, ScriptedLlm } from './aiHelpers.js'
import { startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

const ROOM = 'airoom01'
const CODE = 'function add(a, b) {\n  return a + b\n}\n'

let ts: TestServer
let clients: TestClient[] = []

afterEach(async () => {
  for (const client of clients) client.close()
  clients = []
  await ts.server.close()
})

async function start(llm: ScriptedLlm, options: PairPadServerOptions = {}, quota = { perRoomPerHour: 10, perDay: 100 }) {
  const ai = new AiService({ llm, quota, timeoutMs: 5_000 })
  ts = await startTestServer({ ai, ...options })
  return ai
}

async function connectWithCode(code = CODE): Promise<TestClient> {
  const client = await new TestClient(ts.wsUrl, ROOM).ready()
  clients.push(client)
  if (code) {
    client.text.insert(0, code)
    await waitFor(() => ts.server.rooms.get(ROOM)?.doc.getText('content').toString() === code)
  }
  return client
}

/** The selection a browser would send: Yjs relative positions, as JSON. */
function selectionOf(client: TestClient, from: number, to: number) {
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(client.text, from)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(client.text, to)),
  }
}

function ask(body: unknown, roomId = ROOM) {
  return fetch(`${ts.httpUrl}/api/rooms/${roomId}/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const aiPeer = (client: TestClient) =>
  [...client.peers.values()].find((state) => (state.user as { name?: string })?.name === AI_NAME)

describe('asking the AI for a change', () => {
  it('sends the selected code and instruction to the model and returns its proposal', async () => {
    const llm = new ScriptedLlm().reply('generate', {
      replacement: 'function add(a, b) {\n  if (typeof a !== "number") throw new TypeError("a")\n  return a + b\n}',
      summary: 'Checks that a is a number.',
    })
    await start(llm)
    const alice = await connectWithCode()

    const res = await ask({
      instruction: 'add input validation',
      selection: selectionOf(alice, 0, CODE.length - 1),
      author: 'Alice',
    })
    expect(res.status).toBe(200)
    const { proposal, quota } = (await res.json()) as Record<string, any>
    expect(proposal).toMatchObject({
      from: 0,
      to: CODE.length - 1,
      originalText: CODE.slice(0, -1),
      summary: 'Checks that a is a number.',
      language: 'javascript',
    })
    expect(proposal.proposedText).toContain('TypeError')
    expect(quota.room).toMatchObject({ limit: 10, remaining: 9 })

    const sent = llm.requests[0]!
    expect(sent.role).toBe('generate')
    expect(sent.prompt).toContain('Instruction: add input validation')
    expect(sent.prompt).toContain('<target_region>\nfunction add(a, b) {')
    expect(sent.prompt).toContain('Language: JavaScript')
  })

  it('works on the whole pad when nothing is selected, using the pad\'s language', async () => {
    const llm = new ScriptedLlm().reply('generate', { replacement: 'print("hi")', summary: 's' })
    await start(llm)
    const alice = await connectWithCode('print("hello")')
    alice.doc.getMap('meta').set('language', 'python')
    await waitFor(() => ts.server.rooms.get(ROOM)?.doc.getMap('meta').get('language') === 'python')

    const res = await ask({ instruction: 'say hi', selection: null })
    const { proposal } = (await res.json()) as Record<string, any>
    expect(proposal).toMatchObject({ from: 0, to: 14, originalText: 'print("hello")', language: 'python' })
    expect(llm.requests[0]!.prompt).toContain('Language: Python')
  })

  it('appears in the room with its own name, color and a cursor over the selection while working', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return { replacement: 'x', summary: 's' }
    })
    await start(llm)
    const alice = await connectWithCode()
    const bob = await connectWithCode('')

    const pending = ask({ instruction: 'rename', selection: selectionOf(alice, 9, 12) })
    await waitFor(() => aiPeer(bob) !== undefined)

    const state = aiPeer(bob)!
    expect(state.user).toMatchObject({ name: AI_NAME, color: AI_COLOR, ai: true })
    const cursor = state.cursor as { anchor: unknown; head: unknown }
    const at = (relative: unknown) =>
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(relative), bob.doc)?.index
    expect([at(cursor.anchor), at(cursor.head)]).toEqual([9, 12])
    // It is not a connection, so it does not take one of the 10 places.
    expect(ts.server.rooms.get(ROOM)?.size).toBe(2)

    gate.resolve()
    expect((await pending).status).toBe(200)
    await waitFor(() => aiPeer(bob) === undefined && aiPeer(alice) === undefined)
  })

  it('handles one request per pad at a time', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return { replacement: 'x', summary: 's' }
    })
    const ai = await start(llm)
    await connectWithCode()

    const first = ask({ instruction: 'one' })
    await waitFor(() => ai.isBusy(ROOM))
    const second = await ask({ instruction: 'two' })
    expect(second.status).toBe(429)
    expect(((await second.json()) as { error: string }).error).toMatch(/already working/)

    gate.resolve()
    expect((await first).status).toBe(200)
  })

  it('stops at the hourly cap and reports what is left', async () => {
    const llm = new ScriptedLlm().reply(
      'generate',
      { replacement: 'a', summary: 's' },
      { replacement: 'b', summary: 's' },
    )
    await start(llm, {}, { perRoomPerHour: 2, perDay: 100 })
    await connectWithCode()

    expect((await ask({ instruction: 'one' })).status).toBe(200)
    expect((await ask({ instruction: 'two' })).status).toBe(200)
    const third = await ask({ instruction: 'three' })
    expect(third.status).toBe(429)
    const body = (await third.json()) as Record<string, any>
    expect(body.error).toMatch(/used its 2 AI requests for the hour/)
    expect(body.quota.room.remaining).toBe(0)
    expect(llm.requests).toHaveLength(2)

    const info = (await (await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`)).json()) as Record<string, any>
    expect(info).toMatchObject({ enabled: true, provider: 'Scripted', busy: false })
    expect(info.quota.room).toMatchObject({ limit: 2, remaining: 0 })
    expect(info.quota.day).toMatchObject({ limit: 100, remaining: 98 })
  })

  it('does not count invalid requests against the cap', async () => {
    await start(new ScriptedLlm(), {}, { perRoomPerHour: 1, perDay: 100 })
    await connectWithCode()
    expect((await ask({ instruction: '   ' })).status).toBe(400)
    expect((await ask({ instruction: 'x'.repeat(5_000) })).status).toBe(400)
    const info = (await (await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`)).json()) as Record<string, any>
    expect(info.quota.room.remaining).toBe(1)
  })

  it('refuses a selection that is too large to send to a free model', async () => {
    await start(new ScriptedLlm())
    await connectWithCode('y'.repeat(9_000))
    const res = await ask({ instruction: 'shorten' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/Select less code/)
  })

  it('passes on a friendly message when the providers are busy, and leaves the room', async () => {
    const llm = new ScriptedLlm().reply('generate', new AiError(BUSY_MESSAGE, 'busy'))
    await start(llm)
    const alice = await connectWithCode()

    const res = await ask({ instruction: 'anything' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe(BUSY_MESSAGE)
    await waitFor(() => aiPeer(alice) === undefined)
    // The server carries on as normal.
    alice.text.insert(0, '// still here\n')
    await waitFor(() => ts.server.rooms.get(ROOM)!.doc.getText('content').toString().startsWith('// still here'))
  })

  it('never crashes on an unexpected error from the model layer', async () => {
    const llm = new ScriptedLlm().reply('generate', new TypeError('boom'))
    const errors: string[] = []
    await start(llm, { onError: (_error, context) => errors.push(context) })
    await connectWithCode()

    const res = await ask({ instruction: 'anything' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('The AI request failed unexpectedly.')
    expect(errors).toEqual([`AI request in room ${ROOM}`])
    expect((await fetch(`${ts.httpUrl}/health`)).status).toBe(200)
  })

  it('keeps the room loaded while it works, even if everyone leaves', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return { replacement: 'x', summary: 's' }
    })
    await start(llm, { idleUnloadMs: 0 })
    const alice = await connectWithCode()
    const room = ts.server.rooms.get(ROOM)

    const pending = ask({ instruction: 'go' })
    await waitFor(() => llm.requests.length === 1)
    alice.close()
    await waitFor(() => room!.size === 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ts.server.rooms.get(ROOM)).toBe(room)

    gate.resolve()
    expect((await pending).status).toBe(200)
    await waitFor(() => ts.server.rooms.get(ROOM) === undefined)
  })

  it('needs the pad to be open, and rejects bad input', async () => {
    await start(new ScriptedLlm())
    expect((await ask({ instruction: 'x' }, 'notopen1')).status).toBe(409)
    await connectWithCode()
    const bad = await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`, { method: 'POST', body: '{not json' })
    expect(bad.status).toBe(400)
    expect((await ask({ instruction: 'x', selection: 'everything' })).status).toBe(400)
    const huge = await ask({ instruction: 'x', padding: 'p'.repeat(20_000) })
    expect(huge.status).toBe(413)
  })
})

describe('when no AI provider is configured', () => {
  it('reports the AI as unavailable instead of failing', async () => {
    ts = await startTestServer()
    const info = await (await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`)).json()
    expect(info).toEqual({ enabled: false })
    const res = await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
  })
})
