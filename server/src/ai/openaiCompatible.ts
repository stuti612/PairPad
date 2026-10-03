import OpenAI from 'openai'
import { z } from 'zod'
import { AiError, type LlmClient, type ModelRole, type StructuredRequest } from './llm.js'

export type JsonMode = 'json_schema' | 'json_object'

export interface ProviderSettings {
  /** Short name used in settings, e.g. "groq". */
  id: string
  /** Display name, e.g. "Groq". */
  label: string
  baseURL: string
  apiKey: string
  models: Record<ModelRole, string>
  /**
   * How to ask for JSON. "json_schema" constrains output to the schema;
   * "json_object" only guarantees some JSON, so the shape is checked here.
   */
  jsonMode: JsonMode
}

/**
 * Any provider with an OpenAI-compatible chat completions API: Groq,
 * Cerebras, OpenRouter, GitHub Models, or a custom base URL.
 */
export class OpenAiCompatibleLlm implements LlmClient {
  readonly label: string
  private readonly client: OpenAI

  constructor(private readonly settings: ProviderSettings) {
    this.label = settings.label
    // Retries are handled one level up, by moving to the fallback provider.
    this.client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey, maxRetries: 0 })
  }

  async complete<T>(request: StructuredRequest<T>): Promise<T> {
    const { jsonMode } = this.settings
    try {
      return await this.call(request, jsonMode)
    } catch (error) {
      // Not every model behind a provider supports schema-constrained
      // output; if the provider says so, ask for plain JSON instead.
      if (jsonMode === 'json_schema' && error instanceof OpenAI.BadRequestError) {
        return this.call(request, 'json_object')
      }
      throw error
    }
  }

  private async call<T>(request: StructuredRequest<T>, jsonMode: JsonMode): Promise<T> {
    const model = this.settings.models[request.role]
    let completion
    try {
      completion = await this.client.chat.completions.create(
        {
          model,
          max_completion_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format:
            jsonMode === 'json_schema'
              ? {
                  type: 'json_schema',
                  json_schema: {
                    name: request.schemaName,
                    strict: true,
                    schema: toStrictJsonSchema(request.schema),
                  },
                }
              : { type: 'json_object' },
        },
        { timeout: request.timeoutMs, signal: request.signal },
      )
    } catch (error) {
      if (jsonMode === 'json_schema' && error instanceof OpenAI.BadRequestError) throw error
      throw toAiError(error, this.label)
    }

    const choice = completion.choices[0]
    if (choice?.message.refusal) {
      throw new AiError('The AI model declined this request.', 'refused')
    }
    if (choice?.finish_reason === 'length') {
      throw new AiError('The AI response was cut off because it was too long.', 'format')
    }
    return parseJson(choice?.message.content ?? '', request.schema)
  }
}

/** Turns model text into validated data, tolerating code fences around the JSON. */
export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end < start) {
    throw new AiError('The AI returned a response in an unexpected format.', 'format')
  }
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new AiError('The AI returned a response in an unexpected format.', 'format')
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new AiError('The AI returned a response in an unexpected format.', 'format')
  }
  return parsed.data
}

function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >
  return rest
}

function toAiError(error: unknown, provider: string): AiError {
  if (error instanceof AiError) return error
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AiError('The AI request was cancelled.', 'cancelled')
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiError(`${provider} took too long to respond.`, 'timeout')
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiError(`Could not reach ${provider}.`, 'unavailable')
  }
  // 429 is a rate limit; 402 and some 403s mean the free allowance is used up.
  if (error instanceof OpenAI.RateLimitError || (error instanceof OpenAI.APIError && error.status === 402)) {
    return new AiError(`${provider} is rate limiting requests.`, 'busy')
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return new AiError(`The server's ${provider} API key was not accepted.`, 'auth')
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return new AiError(`${provider} refused access (the free allowance may be used up).`, 'busy')
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new AiError(`${provider} is having problems.`, 'unavailable')
  }
  if (error instanceof OpenAI.APIError) {
    return new AiError(`${provider} rejected the request.`, 'rejected')
  }
  return new AiError('The AI request failed unexpectedly.', 'unavailable')
}
