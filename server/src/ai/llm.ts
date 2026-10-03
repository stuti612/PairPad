import type { z } from 'zod'

/** Which job a call is for. Each provider maps it to one of its models. */
export type ModelRole = 'generate' | 'judge'

/** One model call that must come back as JSON matching `schema`. */
export interface StructuredRequest<T> {
  role: ModelRole
  system: string
  prompt: string
  schema: z.ZodType<T>
  /** Short identifier for the schema, required by some providers. */
  schemaName: string
  maxTokens: number
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * The only thing the AI features need from a model provider. Every call
 * returns validated, typed JSON, so callers never parse model text.
 */
export interface LlmClient {
  /** For logs and the UI, e.g. "Groq". */
  readonly label: string
  complete<T>(request: StructuredRequest<T>): Promise<T>
}

/**
 * Why a call failed. "busy" covers rate limits and used-up free quota; with
 * "unavailable", "timeout" and "auth" it is worth trying another provider.
 */
export type AiErrorKind =
  | 'invalid'
  | 'limited'
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'auth'
  | 'rejected'
  | 'format'
  | 'refused'
  | 'cancelled'

const STATUS: Record<AiErrorKind, number> = {
  invalid: 400,
  limited: 429,
  busy: 503,
  unavailable: 503,
  timeout: 504,
  auth: 503,
  rejected: 502,
  format: 502,
  refused: 502,
  cancelled: 499,
}

/** A failure to show the person who asked, with an HTTP status for the API. */
export class AiError extends Error {
  readonly status: number

  constructor(
    message: string,
    readonly kind: AiErrorKind,
  ) {
    super(message)
    this.status = STATUS[kind]
  }

  get worthFallingBack(): boolean {
    return (
      this.kind === 'busy' ||
      this.kind === 'unavailable' ||
      this.kind === 'timeout' ||
      this.kind === 'auth'
    )
  }
}

export const BUSY_MESSAGE = 'AI is busy, try again in a minute.'
