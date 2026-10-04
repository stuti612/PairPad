import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import { TEXT_KEY } from '../protocol.js'

/** Name of the shared map holding suggestions in each pad's Y.Doc. */
export const SUGGESTIONS_KEY = 'suggestions'
/** Transaction origin for every change the server makes on the AI's behalf. */
export const AI_ORIGIN = 'pairpad-ai'
// Resolved suggestions kept for the history in the panel; older ones are dropped.
const MAX_RESOLVED = 30

export type SuggestionStatus = 'working' | 'pending' | 'accepted' | 'rejected' | 'stale' | 'failed'

export interface Check {
  /** e.g. "Does what was asked". */
  name: string
  /** 0 to 1. */
  score: number
  reason: string
}

/** One AI suggestion, as every client sees it in the shared map. */
export interface Suggestion {
  id: string
  author: string
  instruction: string
  language: string
  status: SuggestionStatus
  /** What the AI is doing while status is "working". */
  phase: string | null
  /**
   * The code the suggestion replaces, as Yjs relative positions. They move
   * with the text, so the range stays on the same code while people type.
   */
  range: { start: unknown; end: unknown }
  originalText: string
  proposedText: string
  summary: string
  /** Average of the checks, 0 to 1, once checked. */
  score: number | null
  checks: Check[]
  /** Result of the syntax check (JavaScript and TypeScript only). */
  syntax: { status: 'passed' | 'failed' | 'skipped'; message: string } | null
  /** Model attempts used: 1, or 2 when the first was turned down by the checks. */
  attempts: number
  /** Why it was not shown as a suggestion, when status is "failed". */
  failureReasons: string[]
  createdAt: number
  updatedAt: number
  resolvedBy: string | null
  /** The suggestion that replaced this one, when it was re-run. */
  replacedBy: string | null
}

const STALE_MESSAGE =
  'The code changed after the AI read it, so the suggestion no longer fits. Re-run it or dismiss it.'

export class SuggestionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * The suggestions of one pad. They live in the pad's Y.Doc so every client
 * sees them, and their status, in real time; but they belong to the server.
 * Only the server writes them, and a client that edits the map directly is
 * overwritten with the server's copy, so a score, a proposal or a status
 * can't be faked by tampering with shared state.
 */
export class SuggestionStore {
  private readonly map: Y.Map<Suggestion>
  private readonly text: Y.Text
  /** The authoritative copy of every suggestion. */
  private readonly truth = new Map<string, Suggestion>()

  constructor(
    private readonly doc: Y.Doc,
    private readonly now: () => number = Date.now,
  ) {
    this.map = doc.getMap<Suggestion>(SUGGESTIONS_KEY)
    this.text = doc.getText(TEXT_KEY)
    for (const [id, suggestion] of this.map) this.truth.set(id, suggestion)
    // Requests that were still running when the server last stopped will
    // never finish, so say so instead of showing them as working forever.
    for (const suggestion of this.truth.values()) {
      if (suggestion.status === 'working') {
        this.write({
          ...suggestion,
          status: 'failed',
          phase: null,
          failureReasons: ['The server restarted while the AI was working. Ask again.'],
        })
      }
    }
    this.map.observe(this.restoreTampered)
    this.text.observe(this.checkFreshness)
    this.checkFreshness()
  }

  get(id: string): Suggestion | undefined {
    return this.truth.get(id)
  }

  all(): Suggestion[] {
    return [...this.truth.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Records a new request, shown to everyone as "working", over `from`..`to`. */
  create(fields: {
    author: string
    instruction: string
    language: string
    from: number
    to: number
  }): Suggestion {
    const now = this.now()
    const suggestion: Suggestion = {
      id: randomBytes(6).toString('hex'),
      author: fields.author,
      instruction: fields.instruction,
      language: fields.language,
      status: 'working',
      phase: 'Writing a suggestion',
      range: anchorRange(this.text, fields.from, fields.to),
      originalText: this.text.toString().slice(fields.from, fields.to),
      proposedText: '',
      summary: '',
      score: null,
      checks: [],
      syntax: null,
      attempts: 0,
      failureReasons: [],
      createdAt: now,
      updatedAt: now,
      resolvedBy: null,
      replacedBy: null,
    }
    this.write(suggestion)
    return suggestion
  }

  update(id: string, changes: Partial<Omit<Suggestion, 'id' | 'createdAt'>>): Suggestion | undefined {
    const current = this.truth.get(id)
    if (!current) return undefined
    const next = { ...current, ...changes }
    this.write(next)
    if (changes.status && isResolved(changes.status)) this.prune()
    return next
  }

  /** Where the suggestion's code is now, or null if it has been deleted. */
  locate(suggestion: Suggestion): { from: number; to: number } | null {
    const start = toIndex(this.doc, this.text, suggestion.range.start)
    const end = toIndex(this.doc, this.text, suggestion.range.end)
    if (start === null || end === null) return null
    return { from: Math.min(start, end), to: Math.max(start, end) }
  }

  /** True when the code under the suggestion is still what the AI saw. */
  isCurrent(suggestion: Suggestion, content = this.text.toString()): boolean {
    const range = this.locate(suggestion)
    return range !== null && content.slice(range.from, range.to) === suggestion.originalText
  }

  /** Records that a suggestion was asked again; `replacement` is the new one. */
  markRerun(id: string, by: string, replacement: string): void {
    this.update(id, { status: 'rejected', resolvedBy: by, replacedBy: replacement, updatedAt: this.now() })
  }

  /**
   * Applies a pending suggestion to the pad: the code edit and the status
   * change happen in one Yjs transaction, so everyone sees both at once.
   * JavaScript runs one request at a time, so of two people clicking Accept
   * together, the first applies it and the second is told it already was.
   */
  accept(id: string, by: string): Suggestion {
    const suggestion = this.pendingOrThrow(id)
    const range = this.locate(suggestion)
    if (range === null || !this.isCurrent(suggestion)) {
      this.update(id, { status: 'stale', updatedAt: this.now() })
      throw new SuggestionError(STALE_MESSAGE, 409)
    }
    let accepted!: Suggestion
    this.doc.transact(() => {
      this.text.delete(range.from, range.to - range.from)
      this.text.insert(range.from, suggestion.proposedText)
      accepted = this.update(id, { status: 'accepted', resolvedBy: by, updatedAt: this.now() })!
    }, AI_ORIGIN)
    return accepted
  }

  /** Discards a pending (or stale) suggestion. The pad's text is not touched. */
  reject(id: string, by: string): Suggestion {
    const suggestion = this.truth.get(id)
    if (!suggestion) throw new SuggestionError('That suggestion does not exist.', 404)
    if (suggestion.status !== 'pending' && suggestion.status !== 'stale') {
      throw new SuggestionError(`This suggestion was already ${describe(suggestion.status)}.`, 409)
    }
    return this.update(id, { status: 'rejected', resolvedBy: by, updatedAt: this.now() })!
  }

  destroy(): void {
    this.map.unobserve(this.restoreTampered)
    this.text.unobserve(this.checkFreshness)
  }

  /**
   * After every change to the pad's text: a pending suggestion whose code
   * was edited becomes stale for everyone, and a stale one whose code is
   * back to what the AI saw (say, after an undo) is pending again.
   */
  private checkFreshness = (): void => {
    const open = [...this.truth.values()].filter(
      (suggestion) => suggestion.status === 'pending' || suggestion.status === 'stale',
    )
    if (open.length === 0) return
    const content = this.text.toString()
    for (const suggestion of open) {
      const current = this.isCurrent(suggestion, content)
      if (suggestion.status === 'pending' && !current) {
        this.update(suggestion.id, { status: 'stale', updatedAt: this.now() })
      } else if (suggestion.status === 'stale' && current) {
        this.update(suggestion.id, { status: 'pending', updatedAt: this.now() })
      }
    }
  }

  private pendingOrThrow(id: string): Suggestion {
    const suggestion = this.truth.get(id)
    if (!suggestion) throw new SuggestionError('That suggestion does not exist.', 404)
    if (suggestion.status === 'stale') throw new SuggestionError(STALE_MESSAGE, 409)
    if (suggestion.status !== 'pending') {
      throw new SuggestionError(`This suggestion was already ${describe(suggestion.status)}.`, 409)
    }
    return suggestion
  }

  private write(suggestion: Suggestion): void {
    this.truth.set(suggestion.id, suggestion)
    this.doc.transact(() => this.map.set(suggestion.id, suggestion), AI_ORIGIN)
  }

  private prune(): void {
    const resolved = this.all().filter((suggestion) => isResolved(suggestion.status))
    const excess = resolved.length - MAX_RESOLVED
    if (excess <= 0) return
    this.doc.transact(() => {
      for (const suggestion of resolved.slice(0, excess)) {
        this.truth.delete(suggestion.id)
        this.map.delete(suggestion.id)
      }
    }, AI_ORIGIN)
  }

  private restoreTampered = (event: Y.YMapEvent<Suggestion>, transaction: Y.Transaction): void => {
    if (transaction.origin === AI_ORIGIN) return
    this.doc.transact(() => {
      for (const id of event.keysChanged) {
        const truth = this.truth.get(id)
        if (truth) this.map.set(id, truth)
        else if (this.map.has(id)) this.map.delete(id)
      }
    }, AI_ORIGIN)
  }
}

function isResolved(status: SuggestionStatus): boolean {
  return status === 'accepted' || status === 'rejected' || status === 'failed'
}

function describe(status: SuggestionStatus): string {
  switch (status) {
    case 'working':
      return 'still being written'
    case 'stale':
      return 'outdated by edits'
    default:
      return status
  }
}

/**
 * The start sticks to the first character of the range and the end to the
 * last, so typing right before or right after the range stays outside it.
 */
function anchorRange(text: Y.Text, from: number, to: number): Suggestion['range'] {
  if (from === to) {
    const point = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from))
    return { start: point, end: point }
  }
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  }
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
