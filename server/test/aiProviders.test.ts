import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aiFromEnv, providerFromEnv } from '../src/ai/config.js'
import { FallbackLlm } from '../src/ai/fallback.js'
import { AiError, BUSY_MESSAGE, type StructuredRequest } from '../src/ai/llm.js'
import { OpenAiCompatibleLlm, parseJson, type ProviderSettings } from '../src/ai/openaiCompatible.js'
import { AiQuota } from '../src/ai/quota.js'
import { apiError, completion, ScriptedLlm, startFakeProvider, type FakeProvider } from './aiHelpers.js'

const Answer = z.object({ replacement: z.string(), summary: z.string() })

const request: StructuredRequest<z.infer<typeof Answer>> = {
  role: 'generate',
  system: 'system prompt',
  prompt: 'user prompt',
  schema: Answer,
  schemaName: 'suggestion',
  maxTokens: 100,
  timeoutMs: 5_000,
}

const answerJson = JSON.stringify({ replacement: 'x = 1', summary: 'Set x.' })

describe('choosing providers from the environment', () => {
  it('defaults to Groq with GitHub Models as the fallback', () => {
    const choice = aiFromEnv({ GROQ_API_KEY: 'gsk_secret', GITHUB_TOKEN: 'ghp_secret' })
    expect(choice.llm).not.toBeNull()
    expect(choice.description).toBe(
      'Groq (openai/gpt-oss-120b, judged by openai/gpt-oss-20b), falling back to GitHub Models (openai/gpt-4.1, judged by openai/gpt-4.1-mini)',
    )
    expect(choice.description).not.toContain('secret')
  })

  it('uses the fallback alone when only its key is set', () => {
    const choice = aiFromEnv({ GITHUB_TOKEN: 'ghp_secret' })
    expect(choice.description).toBe('GitHub Models (openai/gpt-4.1, judged by openai/gpt-4.1-mini)')
  })

  it('is off when no key is set, and says which key to add', () => {
    const choice = aiFromEnv({})
    expect(choice.llm).toBeNull()
    expect(choice.description).toContain('GROQ_API_KEY')
  })

  it('lets every part be overridden without code changes', () => {
    const settings = providerFromEnv('groq', {
      GROQ_API_KEY: 'k',
      GROQ_BASE_URL: 'https://proxy.example/v1',
      GROQ_MODEL: 'big-model',
      GROQ_JUDGE_MODEL: 'small-model',
      GROQ_JSON_MODE: 'json_object',
    })
    expect(settings).toMatchObject({
      baseURL: 'https://proxy.example/v1',
      models: { generate: 'big-model', judge: 'small-model' },
      jsonMode: 'json_object',
    })
  })

  it('supports any OpenAI-compatible provider as "custom"', () => {
    const choice = aiFromEnv({
      AI_PROVIDER: 'custom',
      AI_FALLBACK_PROVIDER: 'none',
      CUSTOM_API_KEY: 'k',
      CUSTOM_BASE_URL: 'http://localhost:11434/v1',
      CUSTOM_MODEL: 'local-big',
      CUSTOM_JUDGE_MODEL: 'local-small',
    })
    expect(choice.description).toBe('Custom provider (local-big, judged by local-small)')
    expect(() => aiFromEnv({ AI_PROVIDER: 'custom', CUSTOM_API_KEY: 'k' })).toThrow(/CUSTOM_BASE_URL/)
  })

  it('only accepts free OpenRouter models', () => {
    expect(() =>
      providerFromEnv('openrouter', { OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'openai/gpt-5' }),
    ).toThrow(/:free/)
    expect(providerFromEnv('openrouter', { OPENROUTER_API_KEY: 'k' })?.models.generate).toMatch(/:free$/)
  })

  it('rejects unknown providers and can be switched off or mocked', () => {
    expect(() => aiFromEnv({ AI_PROVIDER: 'skynet' })).toThrow(/Unknown AI provider/)
    expect(aiFromEnv({ AI_PROVIDER: 'off', GROQ_API_KEY: 'k' }).llm).toBeNull()
    expect(aiFromEnv({ AI_PROVIDER: 'mock' }).llm?.label).toBe('Mock AI')
  })
})

describe('talking to an OpenAI-compatible provider', () => {
  const providers: FakeProvider[] = []
  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.close()
  })

  async function provider(respond: Parameters<typeof startFakeProvider>[0]) {
    const fake = await startFakeProvider(respond)
    providers.push(fake)
    return fake
  }

  const settings = (fake: FakeProvider, overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
    id: 'test',
    label: overrides.label ?? 'Test provider',
    baseURL: fake.baseURL,
    apiKey: 'test-key',
    models: { generate: 'big-model', judge: 'small-model' },
    jsonMode: 'json_schema',
    ...overrides,
  })

  it('asks for schema-constrained JSON with the role\'s model, and validates the answer', async () => {
    const fake = await provider(() => completion(answerJson))
    const llm = new OpenAiCompatibleLlm(settings(fake))

    expect(await llm.complete(request)).toEqual({ replacement: 'x = 1', summary: 'Set x.' })
    const body = fake.bodies[0]!
    expect(body.model).toBe('big-model')
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'suggestion',
        strict: true,
        schema: { type: 'object', required: ['replacement', 'summary'], additionalProperties: false },
      },
    })
    await llm.complete({ ...request, role: 'judge' })
    expect(fake.bodies[1]!.model).toBe('small-model')
  })

  it('falls back to plain JSON mode when the model does not support schemas', async () => {
    const fake = await provider((body) =>
      (body.response_format as { type: string }).type === 'json_schema'
        ? apiError(400, 'json_schema not supported for this model')
        : completion(answerJson),
    )
    const llm = new OpenAiCompatibleLlm(settings(fake))
    expect(await llm.complete(request)).toMatchObject({ replacement: 'x = 1' })
    expect(fake.bodies.map((body) => (body.response_format as { type: string }).type)).toEqual([
      'json_schema',
      'json_object',
    ])
  })

  it('reads JSON wrapped in a code fence, and rejects answers of the wrong shape', () => {
    expect(parseJson('```json\n' + answerJson + '\n```', Answer)).toMatchObject({ summary: 'Set x.' })
    expect(() => parseJson('{"replacement": 3}', Answer)).toThrow(AiError)
    expect(() => parseJson('no json here', Answer)).toThrow(AiError)
  })

  it.each([
    [429, 'busy'],
    [402, 'busy'],
    [401, 'auth'],
    [500, 'unavailable'],
    [422, 'rejected'],
  ])('classifies HTTP %i as "%s"', async (status, kind) => {
    const fake = await provider(() => apiError(status))
    const llm = new OpenAiCompatibleLlm(settings(fake, { jsonMode: 'json_object' }))
    await expect(llm.complete(request)).rejects.toMatchObject({ kind })
  })

  it('treats a cut-off answer as a format failure', async () => {
    const fake = await provider(() => completion('{"replacement": "unfinished', 'length'))
    const llm = new OpenAiCompatibleLlm(settings(fake))
    await expect(llm.complete(request)).rejects.toMatchObject({ kind: 'format' })
  })

  it('moves to the fallback provider once when the primary is rate limited', async () => {
    const primary = await provider(() => apiError(429, 'Rate limit reached'))
    const fallback = await provider(() => completion(answerJson))
    const logs: string[] = []
    const llm = new FallbackLlm(
      new OpenAiCompatibleLlm(settings(primary, { label: 'Groq' })),
      new OpenAiCompatibleLlm(settings(fallback, { label: 'GitHub Models' })),
      (line) => logs.push(line),
    )

    expect(await llm.complete(request)).toMatchObject({ replacement: 'x = 1' })
    expect(primary.bodies).toHaveLength(1)
    expect(fallback.bodies).toHaveLength(1)
    expect(logs[0]).toContain('Trying GitHub Models')
  })

  it('shows a friendly "busy" message when both providers are rate limited', async () => {
    const primary = await provider(() => apiError(429))
    const fallback = await provider(() => apiError(429))
    const llm = new FallbackLlm(
      new OpenAiCompatibleLlm(settings(primary)),
      new OpenAiCompatibleLlm(settings(fallback)),
      () => {},
    )
    await expect(llm.complete(request)).rejects.toMatchObject({ message: BUSY_MESSAGE, kind: 'busy' })
    // Exactly one attempt each: no retry loops that burn the free quota.
    expect(primary.bodies).toHaveLength(1)
    expect(fallback.bodies).toHaveLength(1)
  })

  it('does not fall back for a problem with the request itself', async () => {
    const primary = new ScriptedLlm().reply('generate', new AiError('bad request', 'rejected'))
    const fallback = new ScriptedLlm().reply('generate', { replacement: 'x', summary: 's' })
    const llm = new FallbackLlm(primary, fallback, () => {})
    await expect(llm.complete(request)).rejects.toMatchObject({ kind: 'rejected' })
    expect(fallback.requests).toHaveLength(0)
  })

  it('shows the busy message when there is no fallback configured', async () => {
    const llm = new FallbackLlm(new ScriptedLlm().reply('generate', new AiError('429', 'busy')), null)
    await expect(llm.complete(request)).rejects.toMatchObject({ message: BUSY_MESSAGE })
  })
})

describe('AI request caps', () => {
  const HOUR = 60 * 60 * 1000

  it('allows a set number of requests per room per hour, on a rolling window', () => {
    let now = Date.UTC(2026, 9, 2, 12)
    const quota = new AiQuota({ perRoomPerHour: 3, perDay: 100 }, () => now)
    for (let i = 0; i < 3; i++) {
      expect(quota.take('room0001')).toBeNull()
      now += 10 * 60 * 1000
    }
    expect(quota.take('room0001')).toMatch(/used its 3 AI requests for the hour/)
    expect(quota.status('room0001').room).toMatchObject({ limit: 3, remaining: 0 })
    // Another pad has its own allowance.
    expect(quota.take('room0002')).toBeNull()

    now += 31 * 60 * 1000 // the first request is now more than an hour old
    expect(quota.status('room0001').room.remaining).toBe(1)
    expect(quota.take('room0001')).toBeNull()
  })

  it('caps the whole server per day and resets at midnight UTC', () => {
    let now = Date.UTC(2026, 9, 2, 23, 0)
    const quota = new AiQuota({ perRoomPerHour: 100, perDay: 2 }, () => now)
    expect(quota.take('room0001')).toBeNull()
    expect(quota.take('room0002')).toBeNull()
    expect(quota.take('room0003')).toMatch(/today's free allowance/)
    expect(quota.status('room0003').day).toEqual({ limit: 2, remaining: 0, resetsInSeconds: 3600 })

    now += HOUR
    expect(quota.status('room0003').day.remaining).toBe(2)
    expect(quota.take('room0003')).toBeNull()
  })
})
