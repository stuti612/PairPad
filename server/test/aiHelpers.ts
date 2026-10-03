import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AiError, type LlmClient, type ModelRole, type StructuredRequest } from '../src/ai/llm.js'

type Reply = unknown | Error | ((request: StructuredRequest<unknown>) => unknown | Promise<unknown>)

/**
 * A test double for the model: queue replies per role and inspect the
 * requests it received. A reply can be data, an error to throw, or a
 * function of the request.
 */
export class ScriptedLlm implements LlmClient {
  readonly label = 'Scripted'
  readonly requests: StructuredRequest<unknown>[] = []
  private readonly queues: Record<ModelRole, Reply[]> = { generate: [], judge: [] }

  reply(role: ModelRole, ...replies: Reply[]): this {
    this.queues[role].push(...replies)
    return this
  }

  async complete<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>)
    const next = this.queues[request.role].shift()
    if (next === undefined) throw new AiError(`no scripted ${request.role} reply left`, 'rejected')
    if (next instanceof Error) throw next
    const value = typeof next === 'function' ? await next(request as StructuredRequest<unknown>) : next
    return request.schema.parse(value)
  }
}

/** A promise you resolve from outside, to hold a model call open mid-test. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface FakeProvider {
  baseURL: string
  /** Every request body received, newest last. */
  bodies: Array<Record<string, unknown>>
  close(): Promise<void>
}

/**
 * A local HTTP server speaking enough of the OpenAI chat completions API for
 * the real SDK to talk to it. `respond` decides the status and body.
 */
export async function startFakeProvider(
  respond: (body: Record<string, unknown>) => { status: number; body: unknown },
): Promise<FakeProvider> {
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      bodies.push(body)
      const reply = respond(body)
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A successful chat completion whose message content is `content`. */
export function completion(content: string, finishReason = 'stop') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: { role: 'assistant', content, refusal: null },
        },
      ],
    },
  }
}

export function apiError(status: number, message = 'error') {
  return { status, body: { error: { message, type: 'error' } } }
}
