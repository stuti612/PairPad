// Client side of the AI collaborator. Types mirror server/src/ai/suggestions.ts
// and server/src/ai/quota.ts.

export const SUGGESTIONS_KEY = 'suggestions'

export type SuggestionStatus = 'working' | 'pending' | 'accepted' | 'rejected' | 'stale' | 'failed'

export interface Check {
  name: string
  score: number
  reason: string
}

export interface Suggestion {
  id: string
  author: string
  instruction: string
  language: string
  status: SuggestionStatus
  phase: string | null
  range: { start: unknown; end: unknown }
  originalText: string
  proposedText: string
  summary: string
  score: number | null
  checks: Check[]
  failureReasons: string[]
  createdAt: number
  updatedAt: number
  resolvedBy: string | null
}

export interface Quota {
  room: { limit: number; remaining: number; resetsInSeconds: number }
  day: { limit: number; remaining: number; resetsInSeconds: number }
}

export type AiInfo =
  | { enabled: false }
  | { enabled: true; provider: string; busy: boolean; quota: Quota }

export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly quota?: Quota,
  ) {
    super(message)
  }
}

export async function fetchAiInfo(roomId: string): Promise<AiInfo> {
  const res = await fetch(`/api/rooms/${roomId}/ai`)
  if (!res.ok) throw new Error(`Server responded with ${res.status}`)
  return (await res.json()) as AiInfo
}

/** Starts a request; the result arrives through the shared document. */
export async function askAi(
  roomId: string,
  request: { instruction: string; selection: { anchor: unknown; head: unknown } | null; author: string },
): Promise<{ id: string; quota: Quota }> {
  const res = await fetch(`/api/rooms/${roomId}/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; quota?: Quota; error?: string }
  if (!res.ok || !body.id) {
    throw new AiRequestError(body.error ?? 'The AI request could not be started.', body.quota)
  }
  return { id: body.id, quota: body.quota! }
}

export async function decideSuggestion(
  roomId: string,
  id: string,
  action: 'accept' | 'reject',
  by: string,
): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/suggestions/${id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Could not ${action} the suggestion.`)
  }
}
