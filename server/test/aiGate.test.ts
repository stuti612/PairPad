import { afterEach, describe, expect, it } from 'vitest'
import { verdictFrom } from '../src/ai/judge.js'
import { AiError, BUSY_MESSAGE } from '../src/ai/llm.js'
import { AiService } from '../src/ai/service.js'
import type { Suggestion } from '../src/ai/suggestions.js'
import { checkSyntax } from '../src/ai/syntax.js'
import { judgement, ScriptedLlm } from './aiHelpers.js'
import * as Y from 'yjs'
import { startTestServer, TestClient, waitFor, type TestServer } from './helpers.js'

function selectionOf(client: TestClient, from: number, to: number) {
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(client.text, from)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(client.text, to)),
  }
}

// The verify-then-show gate, with the model replaced by a scripted double.

const ROOM = 'gateroom'
const CODE = 'function add(a, b) {\n  return a + b\n}\n'
const VALID = 'function add(a, b) {\n  if (typeof a !== "number") throw new TypeError("a must be a number")\n  return a + b\n}'
const BROKEN = 'function add(a, b) {\n  if (typeof a !== "number" {\n  return a + b\n}'

let ts: TestServer
let clients: TestClient[] = []

afterEach(async () => {
  for (const client of clients) client.close()
  clients = []
  await ts.server.close()
})

/** Starts a server, opens the pad with CODE (in `language`), asks once, and waits for the outcome. */
async function askThrough(
  llm: ScriptedLlm,
  language = 'javascript',
  code = CODE,
  select?: string,
): Promise<Suggestion> {
  const ai = new AiService({ llm, quota: { perRoomPerHour: 10, perDay: 100 }, timeoutMs: 5_000 })
  ts = await startTestServer({ ai })
  const client = await new TestClient(ts.wsUrl, ROOM).ready()
  clients.push(client)
  client.text.insert(0, code)
  client.doc.getMap('meta').set('language', language)
  await waitFor(() => ts.server.rooms.get(ROOM)?.doc.getText('content').toString() === code)
  await waitFor(() => ts.server.rooms.get(ROOM)?.doc.getMap('meta').get('language') === language)

  const res = await fetch(`${ts.httpUrl}/api/rooms/${ROOM}/ai`, {
    method: 'POST',
    body: JSON.stringify({
      instruction: 'add input validation',
      author: 'Alice',
      selection: select ? selectionOf(client, code.indexOf(select), code.indexOf(select) + select.length) : null,
    }),
  })
  expect(res.status).toBe(202)
  const { id } = (await res.json()) as { id: string }
  await ai.idle()
  const map = client.doc.getMap<Suggestion>('suggestions')
  await waitFor(() => map.get(id)?.status !== undefined && map.get(id)!.status !== 'working')
  return map.get(id)!
}

const write = (replacement: string) => ({ replacement, summary: 'Validates a.' })

describe('the verification gate', () => {
  it('shows a suggestion that parses and that the judge passes, with its score and reasons', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(VALID))
      .reply('judge', judgement({ asked: 0.9, minimal: 0.8, safe: 1 }, { minimal: 'Adds only the check.' }))

    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({
      status: 'pending',
      proposedText: VALID,
      score: 0.9,
      attempts: 1,
      syntax: { status: 'passed', message: 'The code still parses.' },
    })
    expect(suggestion.checks).toEqual([
      { name: 'Does what was asked', score: 0.9, reason: 'Does what was asked.' },
      { name: 'Minimal and in scope', score: 0.8, reason: 'Adds only the check.' },
      { name: 'Safe', score: 1, reason: 'Nothing risky.' },
    ])
    expect([llm.calls('generate'), llm.calls('judge')]).toEqual([1, 1])

    // The judge sees the instruction and both versions of the code.
    const judged = llm.requests.find((request) => request.role === 'judge')!
    expect(judged.prompt).toContain('Instruction: add input validation')
    expect(judged.prompt).toContain(`<original>\n${CODE}\n</original>`)
    expect(judged.prompt).toContain(`<proposed>\n${VALID}\n</proposed>`)
  })

  it('works on the whole function when only its name is selected', async () => {
    const pad = `${CODE}\nfunction greet(name) {\n  return "Hi " + name\n}\n`
    const llm = new ScriptedLlm().reply('generate', write(VALID)).reply('judge', judgement())

    const suggestion = await askThrough(llm, 'javascript', pad, 'add')
    expect(suggestion.originalText).toBe(CODE.trimEnd())
    expect(suggestion).toMatchObject({ status: 'pending', proposedText: VALID, attempts: 1 })
    expect(llm.requests[0]!.prompt).toContain(`<target_region>\n${CODE.trimEnd()}\n</target_region>`)
  })

  it('retries once when the code does not parse, telling the model why, and skips the judge for it', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(BROKEN), write(VALID))
      .reply('judge', judgement())

    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'pending', proposedText: VALID, attempts: 2 })
    // Broken code is never sent to the judge.
    expect([llm.calls('generate'), llm.calls('judge')]).toEqual([2, 1])

    const retry = llm.requests.filter((request) => request.role === 'generate')[1]!
    expect(retry.prompt).toContain('A previous attempt at this instruction was turned down')
    expect(retry.prompt).toMatch(/The result doesn't parse: line 2: '\)' expected/)
    // The model is shown the text on both sides of its replacement...
    expect(retry.prompt).toContain('Your replacement is inserted exactly between these two pieces')
  })

  it('retries once when the judge scores it too low, feeding back the reasons', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(VALID), write(VALID))
      .reply(
        'judge',
        judgement({ asked: 0.4, minimal: 0.5, safe: 0.9 }, { asked: 'Only checks a, not b.', minimal: 'Rewrites the return.' }),
        judgement({ asked: 0.9 }),
      )

    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'pending', attempts: 2, score: 0.93 })
    const retry = llm.requests.filter((request) => request.role === 'generate')[1]!
    expect(retry.prompt).toContain('The average score, 0.60, is below 0.70.')
    expect(retry.prompt).toContain('Does what was asked (0.40): Only checks a, not b.')
    expect(retry.prompt).toContain('Minimal and in scope (0.50): Rewrites the return.')
  })

  it("shows the reasons instead of a diff when it still can't produce a confident suggestion", async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(VALID), write(VALID))
      .reply(
        'judge',
        judgement({ asked: 0.3, minimal: 0.4, safe: 0.9 }, { asked: 'Ignores the instruction.' }),
        judgement({ asked: 0.4, minimal: 0.6, safe: 0.9 }, { asked: 'Still only half done.' }),
      )

    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'failed', attempts: 2, score: 0.63, proposedText: '' })
    expect(suggestion.failureReasons).toEqual([
      'The average score, 0.63, is below 0.70.',
      'Does what was asked (0.40): Still only half done.',
      'Minimal and in scope (0.60): Changes only what is needed.',
    ])
    expect(suggestion.checks).toHaveLength(3)
    // Exactly two attempts: four model calls in all, never more.
    expect(llm.requests).toHaveLength(4)
    // The pad was never touched.
    expect(ts.server.rooms.get(ROOM)!.doc.getText('content').toString()).toBe(CODE)
  })

  it('fails a suggestion that is clearly unsafe even when the average passes', async () => {
    const unsafe = judgement({ asked: 1, minimal: 1, safe: 0.1 }, { safe: 'Deletes the user table.' })
    const llm = new ScriptedLlm().reply('generate', write(VALID), write(VALID)).reply('judge', unsafe, unsafe)

    const suggestion = await askThrough(llm)
    expect(suggestion.status).toBe('failed')
    expect(suggestion.failureReasons).toEqual(['Safe (0.10): Deletes the user table.'])
  })

  it('fails after two broken attempts without ever calling the judge', async () => {
    const llm = new ScriptedLlm().reply('generate', write(BROKEN), write(BROKEN))
    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'failed', attempts: 2, score: null, checks: [] })
    expect(suggestion.syntax?.status).toBe('failed')
    expect(suggestion.failureReasons[0]).toMatch(/doesn't parse/)
    expect(llm.calls('judge')).toBe(0)
  })

  it('counts an unusable judge answer against the attempt', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(VALID), write(VALID))
      // Out of range: the schema accepts any number, the server does not.
      .reply('judge', judgement({ asked: 1.5 }), judgement())

    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'pending', attempts: 2 })
    const retry = llm.requests.filter((request) => request.role === 'generate')[1]!
    expect(retry.prompt).toContain('The automatic check could not be completed: The checker gave an invalid score (1.5).')
  })

  it('stops, without retrying, when the providers are busy during the check', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write(VALID))
      .reply('judge', new AiError(BUSY_MESSAGE, 'busy'))
    const suggestion = await askThrough(llm)
    expect(suggestion).toMatchObject({ status: 'failed', failureReasons: [BUSY_MESSAGE] })
    expect(llm.calls('generate')).toBe(1)
  })

  it('skips the syntax check for Python but still judges', async () => {
    const llm = new ScriptedLlm()
      .reply('generate', write('def add(a, b):\n    return a + b +'))
      .reply('judge', judgement())
    const suggestion = await askThrough(llm, 'python', 'def add(a, b):\n    return a + b\n')
    expect(suggestion).toMatchObject({ status: 'pending', syntax: { status: 'skipped' } })
    expect(llm.calls('judge')).toBe(1)
  })

  it('accepts a change to a pad that already had syntax errors, if it adds none', async () => {
    const unfinished = 'function add(a, b) {\n  return a + b\n}\n\nfunction todo( {\n'
    const llm = new ScriptedLlm()
      .reply('generate', write(`${VALID}\n\nfunction todo( {\n`))
      .reply('judge', judgement())
    const suggestion = await askThrough(llm, 'javascript', unfinished)
    expect(suggestion).toMatchObject({
      status: 'pending',
      syntax: { status: 'passed', message: 'Adds no new syntax errors.' },
    })
  })
})

describe('turning a judgement into a verdict', () => {
  it('passes at an average of 0.70 with every criterion at 0.50 or more', () => {
    expect(verdictFrom(judgement({ asked: 0.7, minimal: 0.7, safe: 0.7 })).passed).toBe(true)
    expect(verdictFrom(judgement({ asked: 0.6, minimal: 0.5, safe: 1 })).passed).toBe(true)
    expect(verdictFrom(judgement({ asked: 0.6, minimal: 0.6, safe: 0.8 })).passed).toBe(false)
    expect(verdictFrom(judgement({ asked: 1, minimal: 1, safe: 0.49 })).passed).toBe(false)
  })

  it('rejects scores outside 0 to 1 and empty reasons', () => {
    expect(() => verdictFrom(judgement({ safe: -0.1 }))).toThrow(/invalid score/)
    expect(() => verdictFrom(judgement({ asked: Number.NaN }))).toThrow(/invalid score/)
    expect(() => verdictFrom(judgement({}, { minimal: '   ' }))).toThrow(/without a reason/)
  })

  it('trims overlong reasons', () => {
    const verdict = verdictFrom(judgement({}, { asked: 'x'.repeat(1000) }))
    expect(verdict.checks[0]!.reason).toHaveLength(240)
    expect(verdict.checks[0]!.reason.endsWith('…')).toBe(true)
  })
})

describe('syntax check', () => {
  it('passes code that parses and fails code that does not', () => {
    expect(checkSyntax('javascript', 'let a = 1', 'let a = 1\nlet b = 2').status).toBe('passed')
    expect(checkSyntax('javascript', 'let a = 1', 'let a = (1').status).toBe('failed')
    expect(checkSyntax('typescript', 'let a = 1', 'let a: number = 1').status).toBe('passed')
    // TypeScript syntax is not valid JavaScript.
    expect(checkSyntax('javascript', 'let a = 1', 'let a: number = 1').status).toBe('failed')
  })

  it('names the line of an error the change introduced', () => {
    const result = checkSyntax('javascript', 'let a = 1\n', 'let a = 1\nlet b = {\n')
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/^The result doesn't parse: line \d+:/)
  })

  it('skips languages it cannot parse', () => {
    expect(checkSyntax('python', 'x =', 'x = = =')).toEqual({ status: 'skipped', message: 'No syntax check for python.' })
    expect(checkSyntax('plaintext', '', '{').status).toBe('skipped')
  })
})
