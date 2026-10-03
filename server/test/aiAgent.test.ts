import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { AiError, BUSY_MESSAGE } from '../src/ai/llm.js'
import { AI_COLOR, AI_NAME } from '../src/ai/presence.js'
import { AiService } from '../src/ai/service.js'
import type { Suggestion } from '../src/ai/suggestions.js'
import type { PairPadServerOptions } from '../src/server.js'
import { deferred, ScriptedLlm } from './aiHelpers.js'
import { startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

export const ROOM = 'airoom01'
const CODE = 'function add(a, b) {\n  return a + b\n}\n'

let ts: TestServer
let ai: AiService
let clients: TestClient[] = []

afterEach(async () => {
  for (const client of clients) client.close()
  clients = []
  await ts.server.close()
})

async function start(
  llm: ScriptedLlm,
  options: PairPadServerOptions = {},
  quota = { perRoomPerHour: 10, perDay: 100 },
) {
  ai = new AiService({ llm, quota, timeoutMs: 5_000 })
  ts = await startTestServer({ ai, ...options })
  return ai
}

async function connectWithCode(code = CODE): Promise<TestClient> {
  const client = await new TestClient(ts.wsUrl, ROOM).ready()
  clients.push(client)
  if (code) {
    client.text.insert(0, code)
    await waitFor(() => serverText() === code)
  }
  return client
}

const serverText = () => ts.server.rooms.get(ROOM)?.doc.getText('content').toString()

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

function decide(id: string, action: 'accept' | 'reject', by = 'Alice') {
  return fetch(`${ts.httpUrl}/api/rooms/${ROOM}/suggestions/${id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ by }),
  })
}

/** A client's view of one suggestion in the shared map. */
const seen = (client: TestClient, id: string) =>
  client.doc.getMap<Suggestion>('suggestions').get(id)

/** Asks, then waits until the client sees the suggestion leave "working". */
async function askAndSettle(client: TestClient, body: unknown): Promise<Suggestion> {
  const res = await ask(body)
  expect(res.status).toBe(202)
  const { id } = (await res.json()) as { id: string }
  await waitFor(() => !!seen(client, id) && seen(client, id)!.status !== 'working')
  return seen(client, id)!
}

const aiPeer = (client: TestClient) =>
  [...client.peers.values()].find((state) => (state.user as { name?: string })?.name === AI_NAME)

const proposal = (replacement: string, summary = 'A change.') => ({ replacement, summary })

describe('asking the AI for a change', () => {
  it('sends the selected code and instruction to the model, and shares the suggestion with everyone', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return proposal(
        'function add(a, b) {\n  if (typeof a !== "number") throw new TypeError("a")\n  return a + b\n}',
        'Checks a.',
      )
    })
    await start(llm)
    const alice = await connectWithCode()
    const bob = await connectWithCode('')

    const res = await ask({
      instruction: 'add input validation',
      selection: selectionOf(alice, 0, CODE.length - 1),
      author: 'Alice',
    })
    expect(res.status).toBe(202)
    const { id, quota } = (await res.json()) as { id: string; quota: any }
    expect(quota.room).toMatchObject({ limit: 10, remaining: 9 })

    // Bob sees the request straight away, while the AI is still writing.
    await waitFor(() => seen(bob, id) !== undefined)
    expect(seen(bob, id)).toMatchObject({
      status: 'working',
      phase: 'Writing a suggestion',
      author: 'Alice',
      instruction: 'add input validation',
    })
    gate.resolve()

    await waitFor(() => seen(bob, id)?.status === 'pending')
    const suggestion = seen(bob, id)!
    expect(suggestion).toMatchObject({
      originalText: CODE.slice(0, -1),
      summary: 'Checks a.',
      language: 'javascript',
      phase: null,
    })
    expect(suggestion.proposedText).toContain('TypeError')
    // The anchored range resolves to the selected code in Bob's own copy.
    const at = (relative: unknown) =>
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(relative), bob.doc)?.index
    expect([at(suggestion.range.start), at(suggestion.range.end)]).toEqual([0, CODE.length - 1])

    const sent = llm.requests[0]!
    expect(sent.role).toBe('generate')
    expect(sent.prompt).toContain('Instruction: add input validation')
    expect(sent.prompt).toContain('<target_region>\nfunction add(a, b) {')
    expect(sent.prompt).toContain('Language: JavaScript')
    // Asking does not touch the code itself.
    expect(serverText()).toBe(CODE)
  })

  it("works on the whole pad when nothing is selected, using the pad's language", async () => {
    const llm = new ScriptedLlm().reply('generate', proposal('print("hi")'))
    await start(llm)
    const alice = await connectWithCode('print("hello")')
    alice.doc.getMap('meta').set('language', 'python')
    await waitFor(() => ts.server.rooms.get(ROOM)?.doc.getMap('meta').get('language') === 'python')

    const suggestion = await askAndSettle(alice, { instruction: 'say hi', selection: null })
    expect(suggestion).toMatchObject({ originalText: 'print("hello")', language: 'python', status: 'pending' })
    expect(llm.requests[0]!.prompt).toContain('Language: Python')
  })

  it('appears in the room with its own name, color and a cursor over the selection while working', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return proposal('x')
    })
    await start(llm)
    const alice = await connectWithCode()
    const bob = await connectWithCode('')

    await ask({ instruction: 'rename', selection: selectionOf(alice, 9, 12) })
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
    await waitFor(() => aiPeer(bob) === undefined && aiPeer(alice) === undefined)
  })

  it('handles one request per pad at a time', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return proposal('x')
    })
    await start(llm)
    await connectWithCode()

    expect((await ask({ instruction: 'one' })).status).toBe(202)
    const second = await ask({ instruction: 'two' })
    expect(second.status).toBe(429)
    expect(((await second.json()) as { error: string }).error).toMatch(/already working/)
    gate.resolve()
    await ai.idle()
    expect(ai.isBusy(ROOM)).toBe(false)
  })

  it('stops at the hourly cap and reports what is left', async () => {
    const llm = new ScriptedLlm().reply('generate', proposal('a'), proposal('b'))
    await start(llm, {}, { perRoomPerHour: 2, perDay: 100 })
    const alice = await connectWithCode()

    await askAndSettle(alice, { instruction: 'one' })
    await askAndSettle(alice, { instruction: 'two' })
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

  it('shows a friendly message on the suggestion when the providers are busy', async () => {
    const llm = new ScriptedLlm().reply('generate', new AiError(BUSY_MESSAGE, 'busy'))
    await start(llm)
    const alice = await connectWithCode()

    const suggestion = await askAndSettle(alice, { instruction: 'anything' })
    expect(suggestion).toMatchObject({ status: 'failed', failureReasons: [BUSY_MESSAGE] })
    await waitFor(() => aiPeer(alice) === undefined)
    // The pad carries on as normal.
    alice.text.insert(0, '// still here\n')
    await waitFor(() => serverText()!.startsWith('// still here'))
  })

  it('never crashes on an unexpected error from the model layer', async () => {
    const llm = new ScriptedLlm().reply('generate', new TypeError('boom'))
    await start(llm)
    const alice = await connectWithCode()

    const suggestion = await askAndSettle(alice, { instruction: 'anything' })
    expect(suggestion).toMatchObject({ status: 'failed', failureReasons: ['The AI request failed unexpectedly.'] })
    expect((await fetch(`${ts.httpUrl}/health`)).status).toBe(200)
  })

  it('keeps the room loaded while it works, even if everyone leaves', async () => {
    const gate = deferred()
    const llm = new ScriptedLlm().reply('generate', async () => {
      await gate.promise
      return proposal('x')
    })
    await start(llm, { idleUnloadMs: 0 })
    const alice = await connectWithCode()
    const room = ts.server.rooms.get(ROOM)

    expect((await ask({ instruction: 'go' })).status).toBe(202)
    await waitFor(() => llm.requests.length === 1)
    alice.close()
    await waitFor(() => room!.size === 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ts.server.rooms.get(ROOM)).toBe(room)

    gate.resolve()
    await ai.idle()
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

describe('accepting and rejecting', () => {
  const NEW_BODY = '  return Number(a) + Number(b)'

  /** A pending suggestion replacing line 2 of CODE. */
  async function pendingSuggestion() {
    const llm = new ScriptedLlm().reply('generate', proposal(NEW_BODY, 'Coerces to numbers.'))
    await start(llm)
    const alice = await connectWithCode()
    const bob = await connectWithCode('')
    const lineStart = CODE.indexOf('  return')
    const lineEnd = CODE.indexOf('\n', lineStart)
    const suggestion = await askAndSettle(alice, {
      instruction: 'coerce to numbers',
      selection: selectionOf(alice, lineStart, lineEnd),
    })
    expect(suggestion.status).toBe('pending')
    return { alice, bob, id: suggestion.id }
  }

  const ACCEPTED = CODE.replace('  return a + b', NEW_BODY)

  it('applies the change and marks it accepted, for everyone, in one step', async () => {
    const { alice, bob, id } = await pendingSuggestion()
    const changes: Array<[string, string | undefined]> = []
    // Each transaction Bob receives: the text and the status always move together.
    bob.doc.on('afterTransaction', () => changes.push([bob.text.toString(), seen(bob, id)?.status]))

    const res = await decide(id, 'accept', 'Bob')
    expect(res.status).toBe(200)
    await waitFor(() => bob.text.toString() === ACCEPTED && alice.text.toString() === ACCEPTED)
    expect(seen(alice, id)).toMatchObject({ status: 'accepted', resolvedBy: 'Bob' })
    expect(changes.filter(([text]) => text === ACCEPTED).every(([, status]) => status === 'accepted')).toBe(true)
    expect(changes.filter(([text]) => text === CODE).every(([, status]) => status === 'pending')).toBe(true)
  })

  it('applies exactly once when several people click Accept at the same moment', async () => {
    const { alice, bob, id } = await pendingSuggestion()

    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => decide(id, 'accept', `Person ${i}`)))
    const statuses = responses.map((res) => res.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409, 409])
    const refusal = (await responses.find((res) => res.status === 409)!.json()) as { error: string }
    expect(refusal.error).toBe('This suggestion was already accepted.')

    await waitFor(() => alice.text.toString() === ACCEPTED && bob.text.toString() === ACCEPTED)
    expect(serverText()).toBe(ACCEPTED)
    expect(serverText()!.split('Number(a)').length - 1).toBe(1)
  })

  it('rejecting discards the suggestion and leaves the code alone', async () => {
    const { alice, bob, id } = await pendingSuggestion()

    expect((await decide(id, 'reject', 'Alice')).status).toBe(200)
    await waitFor(() => seen(bob, id)?.status === 'rejected')
    expect(seen(bob, id)!.resolvedBy).toBe('Alice')
    expect(serverText()).toBe(CODE)
    expect(alice.text.toString()).toBe(CODE)
    expect(bob.text.toString()).toBe(CODE)

    // Once decided, it stays decided.
    expect((await decide(id, 'accept')).status).toBe(409)
    expect((await decide(id, 'reject')).status).toBe(409)
    expect(serverText()).toBe(CODE)
  })

  it('cannot be rejected after being accepted', async () => {
    const { id } = await pendingSuggestion()
    expect((await decide(id, 'accept')).status).toBe(200)
    const res = await decide(id, 'reject')
    expect(res.status).toBe(409)
    expect(serverText()).toBe(ACCEPTED)
  })

  it('still applies in the right place after people edit around the code', async () => {
    const { alice, id } = await pendingSuggestion()
    alice.text.insert(0, '// header\n')
    alice.text.insert(alice.text.length, '// footer\n')
    await waitFor(() => serverText()!.endsWith('// footer\n'))

    expect((await decide(id, 'accept')).status).toBe(200)
    expect(serverText()).toBe(`// header\n${ACCEPTED}// footer\n`)
  })

  it('refuses, and marks the suggestion stale, when the code under it was edited', async () => {
    const { alice, bob, id } = await pendingSuggestion()
    const at = CODE.indexOf('a + b')
    alice.text.insert(at, '2 * ')
    const edited = alice.text.toString()
    await waitFor(() => serverText() === edited)

    const res = await decide(id, 'accept')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/code changed/)
    await waitFor(() => seen(bob, id)?.status === 'stale')
    expect(serverText()).toBe(edited)
    // A stale suggestion can still be dismissed.
    expect((await decide(id, 'reject')).status).toBe(200)
  })

  it('answers 404 for a suggestion that does not exist', async () => {
    await pendingSuggestion()
    expect((await decide('abcdef123456', 'accept')).status).toBe(404)
  })
})

describe('suggestions belong to the server', () => {
  it('undoes a client changing a suggestion in the shared map', async () => {
    const llm = new ScriptedLlm().reply('generate', proposal('x = 1'))
    await start(llm)
    const alice = await connectWithCode()
    const bob = await connectWithCode('')
    const { id } = await askAndSettle(alice, { instruction: 'set x' })

    // Mallory edits shared state directly: a perfect score and different code.
    const map = alice.doc.getMap<Suggestion>('suggestions')
    map.set(id, { ...map.get(id)!, score: 1, proposedText: 'stealCookies()' })
    map.set('fake00000001', { ...map.get(id)!, id: 'fake00000001', instruction: 'trust me' })

    await waitFor(() => seen(bob, id)?.proposedText === 'x = 1' && !bob.doc.getMap('suggestions').has('fake00000001'))
    await waitFor(() => seen(alice, id)?.proposedText === 'x = 1')
    expect(seen(alice, id)!.score).toBeNull()
    expect((await decide('fake00000001', 'accept')).status).toBe(404)
    expect((await decide(id, 'accept')).status).toBe(200)
    expect(serverText()).toBe('x = 1')
  })
})
