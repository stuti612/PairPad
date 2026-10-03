import * as Y from 'yjs'
import { TEXT_KEY } from '../protocol.js'
import type { Room } from '../room.js'
import { judge, type Verdict } from './judge.js'
import { AiError, type LlmClient } from './llm.js'
import { AiPresence } from './presence.js'
import { GENERATION_SYSTEM, generationPrompt, SuggestionSchema } from './prompts.js'
import { AiQuota, type QuotaLimits, type QuotaStatus } from './quota.js'
import { SuggestionStore, type Suggestion } from './suggestions.js'
import { checkSyntax, type SyntaxResult } from './syntax.js'

// Free tiers allow only a few thousand tokens per minute, so what is sent to
// the model is bounded: the selection itself, plus surrounding code.
export const MAX_INSTRUCTION_CHARS = 1_000
export const MAX_TARGET_CHARS = 8_000
const MAX_CONTEXT_CHARS = 12_000
const MAX_AUTHOR_CHARS = 40
const GENERATION_MAX_TOKENS = 4_096
// The first attempt, plus one retry that is told why the first was turned down.
const MAX_ATTEMPTS = 2

export interface AiServiceOptions {
  llm: LlmClient
  quota: QuotaLimits
  /** Longest a whole AI request may take, all model calls included. */
  timeoutMs: number
  now?: () => number
}

export interface AiRequestInput {
  instruction: string
  /** The requester's selection as Yjs relative positions, or null for the whole pad. */
  selection: { anchor: unknown; head: unknown } | null
  author: string
}

export class AiService {
  readonly quota: AiQuota
  private readonly busyRooms = new Set<string>()
  private readonly stores = new WeakMap<Room, SuggestionStore>()
  /** Work started by start(), so tests and shutdown can wait for it. */
  private readonly running = new Set<Promise<void>>()
  private readonly aborts = new Set<AbortController>()
  private shuttingDown = false

  constructor(private readonly options: AiServiceOptions) {
    this.quota = new AiQuota(options.quota, options.now)
  }

  get label(): string {
    return this.options.llm.label
  }

  quotaFor(roomId: string): QuotaStatus {
    return this.quota.status(roomId)
  }

  isBusy(roomId: string): boolean {
    return this.busyRooms.has(roomId)
  }

  /**
   * Called when a room loads, so its suggestions are guarded from the start
   * (see SuggestionStore).
   */
  attach(room: Room): SuggestionStore {
    let store = this.stores.get(room)
    if (!store) {
      store = new SuggestionStore(room.doc, this.options.now)
      this.stores.set(room, store)
    }
    return store
  }

  /** Accepts a pending suggestion, applying it to the pad exactly once. */
  accept(room: Room, id: string, by: string): Suggestion {
    return this.attach(room).accept(id, cleanAuthor(by))
  }

  reject(room: Room, id: string, by: string): Suggestion {
    return this.attach(room).reject(id, cleanAuthor(by))
  }

  /** Stops every running request (as failed) and waits for them, before shutdown. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const abort of this.aborts) abort.abort()
    await this.idle()
  }

  /** Resolves once every request started so far has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running])
  }

  /**
   * Starts an AI request and returns the new suggestion straight away, with
   * status "working". The result arrives in the shared map for everyone.
   * Problems found before starting (bad input, caps) are thrown instead.
   * `onSettled` runs when the work is over, whatever the outcome.
   */
  start(room: Room, input: unknown, onSettled: () => void = () => {}): Suggestion {
    const request = parseRequest(input)
    if (this.busyRooms.has(room.id)) {
      throw new AiError(
        'PairPad AI is already working on a request in this pad. Wait for it to finish.',
        'limited',
      )
    }
    const text = room.doc.getText(TEXT_KEY)
    const { from, to } = resolveRange(room.doc, text, request.selection)
    if (to - from > MAX_TARGET_CHARS) {
      throw new AiError(
        `Select less code: the AI works on up to ${MAX_TARGET_CHARS.toLocaleString('en')} characters at a time.`,
        'invalid',
      )
    }
    const language = String(room.doc.getMap('meta').get('language') ?? 'javascript')
    // Counted only once the request is known to be valid.
    const refusal = this.quota.take(room.id)
    if (refusal) throw new AiError(refusal, 'limited')

    const store = this.attach(room)
    const suggestion = store.create({
      author: request.author,
      instruction: request.instruction,
      language,
      from,
      to,
    })
    this.busyRooms.add(room.id)
    const work = this.run(room, store, suggestion, { from, to })
      .catch((error) => {
        // run() records its own failures; this only guards against a bug there.
        console.error('Unexpected error in AI request:', error)
        try {
          store.update(suggestion.id, {
            status: 'failed',
            phase: null,
            failureReasons: ['The AI request failed unexpectedly.'],
          })
        } catch {
          // The room may already be gone; there is nobody left to tell.
        }
      })
      .finally(() => {
        this.busyRooms.delete(room.id)
        this.running.delete(work)
        onSettled()
      })
    this.running.add(work)
    return suggestion
  }

  /**
   * The verify-then-show gate. Each attempt writes a candidate, checks that
   * the pad still parses (JavaScript/TypeScript), then has the judge model
   * score it. Only a candidate that passes both is shown. A failed attempt
   * is retried once, with the reasons fed back; if that fails too, people
   * see why instead of a doubtful diff.
   */
  private async run(
    room: Room,
    store: SuggestionStore,
    suggestion: Suggestion,
    { from, to }: { from: number; to: number },
  ): Promise<void> {
    const text = room.doc.getText(TEXT_KEY)
    // Everything is judged against the pad as it was when the request came in.
    const content = text.toString()
    const original = content.slice(from, to)
    const { language, instruction } = suggestion
    const presence = new AiPresence(room)
    const abort = new AbortController()
    this.aborts.add(abort)
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs)
    const call = { timeoutMs: this.options.timeoutMs, signal: abort.signal }
    const setPhase = (phase: string) => {
      presence.show(text, from, to, phase)
      store.update(suggestion.id, { phase, updatedAt: this.now() })
    }

    try {
      let failures: string[] = []
      let syntax: SyntaxResult | null = null
      let verdict: Verdict | null = null
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const retry = attempt > 1
        setPhase(retry ? 'Trying again' : 'Writing a suggestion')
        const candidate = await this.options.llm.complete({
          role: 'generate',
          system: GENERATION_SYSTEM,
          prompt: generationPrompt({
            language,
            instruction,
            ...surroundings(content, from, to),
            previousFailures: retry ? failures : undefined,
          }),
          schema: SuggestionSchema,
          schemaName: 'suggestion',
          maxTokens: GENERATION_MAX_TOKENS,
          ...call,
        })

        setPhase(retry ? 'Checking it again' : 'Checking it')
        const result = content.slice(0, from) + candidate.replacement + content.slice(to)
        syntax = checkSyntax(language, content, result)
        verdict = null
        failures = []
        if (syntax.status === 'failed') {
          // No point asking the judge about code that doesn't parse.
          failures = [syntax.message]
        } else {
          try {
            verdict = await judge(
              this.options.llm,
              {
                language,
                instruction,
                original,
                proposed: candidate.replacement,
                before: content.slice(0, from),
                after: content.slice(to),
              },
              call,
            )
            failures = verdict.reasons
          } catch (error) {
            // An unusable judge answer counts against the attempt; anything
            // else (busy, timeout) ends the request below.
            if (!(error instanceof AiError && error.kind === 'format')) throw error
            failures = [`The automatic check could not be completed: ${error.message}`]
          }
        }

        if (failures.length === 0 && verdict) {
          store.update(suggestion.id, {
            status: 'pending',
            phase: null,
            proposedText: candidate.replacement,
            summary: candidate.summary,
            score: verdict.score,
            checks: verdict.checks,
            syntax,
            attempts: attempt,
            updatedAt: this.now(),
          })
          return
        }
      }

      store.update(suggestion.id, {
        status: 'failed',
        phase: null,
        score: verdict?.score ?? null,
        checks: verdict?.checks ?? [],
        syntax,
        attempts: MAX_ATTEMPTS,
        failureReasons: failures,
        updatedAt: this.now(),
      })
    } catch (error) {
      const message = this.shuttingDown
        ? 'The server restarted while the AI was working. Ask again.'
        : abort.signal.aborted
          ? 'The AI took too long and the request was stopped. Try again.'
          : error instanceof AiError
            ? error.message
            : 'The AI request failed unexpectedly.'
      store.update(suggestion.id, {
        status: 'failed',
        phase: null,
        failureReasons: [message],
        updatedAt: this.now(),
      })
    } finally {
      clearTimeout(timer)
      this.aborts.delete(abort)
      presence.leave()
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

function parseRequest(input: unknown): AiRequestInput {
  const body = (input ?? {}) as Record<string, unknown>
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
  if (!instruction) throw new AiError('Type an instruction for the AI.', 'invalid')
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new AiError(
      `Keep the instruction under ${MAX_INSTRUCTION_CHARS.toLocaleString('en')} characters.`,
      'invalid',
    )
  }
  const author = cleanAuthor(body.author)
  const selection = body.selection as AiRequestInput['selection'] | undefined
  if (selection != null && (typeof selection !== 'object' || !('anchor' in selection) || !('head' in selection))) {
    throw new AiError('The selection was not understood.', 'invalid')
  }
  return { instruction, author, selection: selection ?? null }
}

function cleanAuthor(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_AUTHOR_CHARS)
    : 'Someone'
}

function resolveRange(
  doc: Y.Doc,
  text: Y.Text,
  selection: AiRequestInput['selection'],
): { from: number; to: number } {
  if (!selection) return { from: 0, to: text.length }
  const anchor = toIndex(doc, text, selection.anchor)
  const head = toIndex(doc, text, selection.head)
  if (anchor === null || head === null) {
    throw new AiError('The selected code has changed. Select it again.', 'invalid')
  }
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) }
}

function toIndex(doc: Y.Doc, text: Y.Text, relative: unknown): number | null {
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(relative),
      doc,
    )
    return position && position.type === text ? position.index : null
  } catch {
    return null
  }
}

/**
 * The code around the target, shortened at line boundaries when the pad is
 * large. The model is told where lines were left out.
 */
function surroundings(content: string, from: number, to: number) {
  let before = content.slice(0, from)
  let after = content.slice(to)
  const budget = MAX_CONTEXT_CHARS
  if (before.length + after.length > budget) {
    const half = Math.floor(budget / 2)
    const keepBefore = Math.min(before.length, Math.max(half, budget - after.length))
    const keepAfter = Math.min(after.length, budget - keepBefore)
    if (keepBefore < before.length) {
      const cut = before.indexOf('\n', before.length - keepBefore)
      const omitted = before.slice(0, cut + 1).split('\n').length - 1
      before = `[${omitted} earlier lines not shown]\n${before.slice(cut + 1)}`
    }
    if (keepAfter < after.length) {
      const cut = after.lastIndexOf('\n', keepAfter)
      const omitted = after.slice(cut).split('\n').length - 1
      after = `${after.slice(0, cut + 1)}[${omitted} later lines not shown]`
    }
  }
  return { before, target: content.slice(from, to), after }
}
