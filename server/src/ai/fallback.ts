import { AiError, BUSY_MESSAGE, type LlmClient, type StructuredRequest } from './llm.js'

/**
 * Tries the primary provider, and on a rate limit, used-up quota, outage,
 * timeout or bad key, tries the fallback once. If that fails too, the
 * person sees a short "try again" message rather than provider details.
 */
export class FallbackLlm implements LlmClient {
  readonly label: string

  constructor(
    private readonly primary: LlmClient,
    private readonly fallback: LlmClient | null,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {
    this.label = fallback ? `${primary.label}, falling back to ${fallback.label}` : primary.label
  }

  async complete<T>(request: StructuredRequest<T>): Promise<T> {
    try {
      return await this.primary.complete(request)
    } catch (error) {
      const failure = asAiError(error)
      if (!failure.worthFallingBack) throw failure
      if (!this.fallback) throw friendly(failure)
      this.log(`AI: ${failure.message} Trying ${this.fallback.label}.`)
      try {
        return await this.fallback.complete(request)
      } catch (fallbackError) {
        const second = asAiError(fallbackError)
        this.log(`AI: ${second.message}`)
        throw second.worthFallingBack ? friendly(second) : second
      }
    }
  }
}

function asAiError(error: unknown): AiError {
  return error instanceof AiError
    ? error
    : new AiError('The AI request failed unexpectedly.', 'unavailable')
}

function friendly(error: AiError): AiError {
  return new AiError(BUSY_MESSAGE, error.kind === 'timeout' ? 'timeout' : 'busy')
}
