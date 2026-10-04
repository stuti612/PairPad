import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import {
  AiRequestError,
  askAi,
  decideSuggestion,
  rerunSuggestion,
  type AiInfo,
  type Quota,
  type Suggestion,
} from '../lib/ai'

export interface Selection {
  from: number
  to: number
}

interface AiPanelProps {
  roomId: string
  text: Y.Text
  info: AiInfo | null
  onInfoChange: () => void
  suggestions: Suggestion[]
  /** The requester's current selection in the editor. */
  selection: Selection
  author: string
  connected: boolean
  onClose: () => void
  /** Scroll the editor to a suggestion. */
  onFocusSuggestion: (suggestion: Suggestion) => void
}

export function AiPanel(props: AiPanelProps) {
  const { info, suggestions, onClose } = props
  const newestFirst = [...suggestions].reverse()

  return (
    <aside className="ai-panel" aria-label="PairPad AI">
      <header className="ai-panel-header">
        <h2>
          <AiMark /> PairPad AI
        </h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close the AI panel">
          ×
        </button>
      </header>
      {info === null ? (
        <p className="ai-muted">Loading…</p>
      ) : !info.enabled ? (
        <p className="ai-muted">
          The AI collaborator isn't set up on this server. Add a free Groq API key to turn it on;
          see "AI collaborator: free setup" in the README.
        </p>
      ) : (
        <>
          <AskForm {...props} quota={info.quota} />
          <section className="ai-suggestions" aria-label="Suggestions">
            {newestFirst.length === 0 ? (
              <p className="ai-muted">
                Suggestions appear here and in the editor for everyone in the pad. Each one needs a
                person to accept it.
              </p>
            ) : (
              newestFirst.map((suggestion) => (
                <SuggestionCard key={suggestion.id} suggestion={suggestion} {...props} />
              ))
            )}
          </section>
        </>
      )}
    </aside>
  )
}

function AskForm({
  roomId,
  text,
  selection,
  author,
  connected,
  quota,
  suggestions,
  onInfoChange,
}: AiPanelProps & { quota: Quota }) {
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const working = suggestions.some((suggestion) => suggestion.status === 'working')
  const outOfRequests = quota.room.remaining === 0 || quota.day.remaining === 0

  // Requests finishing change what is left, so refresh the count then.
  const workingRef = useRef(working)
  useEffect(() => {
    if (workingRef.current && !working) onInfoChange()
    workingRef.current = working
  }, [working, onInfoChange])

  const hasSelection = selection.to > selection.from
  const target = hasSelection ? describeSelection(text, selection) : 'No selection: the whole pad'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!instruction.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      await askAi(roomId, {
        instruction: instruction.trim(),
        selection: hasSelection
          ? {
              anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, selection.from)),
              head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, selection.to)),
            }
          : null,
        author,
      })
      setInstruction('')
    } catch (failure) {
      setError(
        failure instanceof AiRequestError
          ? failure.message
          : 'Could not reach the server. Check your connection and try again.',
      )
    } finally {
      setSending(false)
      onInfoChange()
    }
  }

  const disabledReason = !connected
    ? 'Reconnect to ask the AI.'
    : working
      ? 'PairPad AI is working on a request in this pad.'
      : outOfRequests
        ? 'No AI requests left for now.'
        : null

  return (
    <form className="ai-form" onSubmit={submit}>
      <label className="ai-field">
        <span>Instruction</span>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event)
          }}
          placeholder="e.g. add input validation to this function"
          rows={3}
          maxLength={1000}
        />
      </label>
      <p className="ai-target">{target}</p>
      <div className="ai-form-row">
        <button
          className="button button-ai"
          type="submit"
          disabled={!instruction.trim() || sending || disabledReason !== null}
        >
          {sending ? 'Asking…' : 'Ask AI'}
        </button>
        <QuotaLine quota={quota} />
      </div>
      {disabledReason && <p className="ai-muted">{disabledReason}</p>}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function QuotaLine({ quota }: { quota: Quota }) {
  return (
    <span className="ai-quota" title="AI requests are capped to stay within free API allowances.">
      {quota.room.remaining} of {quota.room.limit} left this hour · {quota.day.remaining} today
    </span>
  )
}

function SuggestionCard({
  suggestion,
  roomId,
  author,
  connected,
  onFocusSuggestion,
  onInfoChange,
  suggestions,
}: AiPanelProps & { suggestion: Suggestion }) {
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  const { status } = suggestion

  async function decide(action: 'accept' | 'reject' | 'rerun') {
    setDeciding(true)
    setError(null)
    try {
      if (action === 'rerun') await rerunSuggestion(roomId, suggestion.id, author)
      else await decideSuggestion(roomId, suggestion.id, action, author)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong.')
    } finally {
      setDeciding(false)
      if (action === 'rerun') onInfoChange()
    }
  }
  const aiBusy = suggestions.some((other) => other.status === 'working')

  const canFocus = status === 'pending' || status === 'stale'
  return (
    <article className={`ai-card ai-card-${status}`} data-status={status} aria-label={`Suggestion: ${suggestion.instruction}`}>
      <div className="ai-card-top">
        <StatusBadge suggestion={suggestion} />
        {suggestion.score !== null && <ScoreBadge score={suggestion.score} />}
      </div>
      <button
        className="ai-card-instruction"
        type="button"
        disabled={!canFocus}
        onClick={() => onFocusSuggestion(suggestion)}
        title={canFocus ? 'Show in the editor' : undefined}
      >
        “{suggestion.instruction}”
      </button>
      <p className="ai-card-meta">Asked by {suggestion.author}</p>
      {suggestion.summary && status !== 'failed' && <p className="ai-card-summary">{suggestion.summary}</p>}
      {(status === 'pending' || status === 'stale' || status === 'accepted') && (
        <Verification suggestion={suggestion} />
      )}
      {suggestion.checks.length > 0 && (
        <ul className="ai-checks">
          {suggestion.checks.map((check) => (
            <li key={check.name}>
              <span className="ai-check-name">{check.name}</span>
              <span className="ai-check-score">{check.score.toFixed(2)}</span>
              <span className="ai-check-reason">{check.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {status === 'failed' && (
        <div className="ai-card-failure">
          <p>AI couldn't produce a confident suggestion.</p>
          {suggestion.failureReasons.length > 0 && (
            <ul>
              {suggestion.failureReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status === 'stale' && (
        <p className="ai-card-note">
          The code changed after the AI read it, so this no longer fits. Re-run it on the current code, or
          dismiss it.
        </p>
      )}
      {(status === 'accepted' || status === 'rejected') && suggestion.resolvedBy && (
        <p className="ai-card-note">
          {status === 'accepted' ? 'Accepted' : suggestion.replacedBy ? 'Re-run' : 'Rejected'} by{' '}
          {suggestion.resolvedBy}
        </p>
      )}
      {(status === 'pending' || status === 'stale' || status === 'failed') && (
        <div className="ai-card-actions">
          {status === 'pending' && (
            <button
              className="button button-accept"
              type="button"
              disabled={!connected || deciding}
              onClick={() => decide('accept')}
            >
              Accept
            </button>
          )}
          {(status === 'stale' || status === 'failed') && (
            <button
              className="button"
              type="button"
              disabled={!connected || deciding || aiBusy}
              title={aiBusy ? 'PairPad AI is working on another request.' : 'Ask again, on the code as it is now'}
              onClick={() => decide('rerun')}
            >
              Re-run
            </button>
          )}
          {status !== 'failed' && (
            <button
              className="button"
              type="button"
              disabled={!connected || deciding}
              onClick={() => decide('reject')}
            >
              {status === 'pending' ? 'Reject' : 'Dismiss'}
            </button>
          )}
        </div>
      )}
      {/* A refused Accept on outdated code is already explained by the stale note. */}
      {error && status !== 'stale' && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

/** How the suggestion got past the checks, shown above the scores. */
function Verification({ suggestion }: { suggestion: Suggestion }) {
  const notes: string[] = []
  if (suggestion.syntax?.status === 'passed') notes.push(suggestion.syntax.message)
  if (suggestion.attempts > 1) notes.push('Passed on the second try, after the first was turned down.')
  if (notes.length === 0) return null
  return <p className="ai-card-note">{notes.join(' ')}</p>
}

const STATUS_LABELS: Record<Suggestion['status'], string> = {
  working: 'Working',
  pending: 'Suggestion',
  accepted: 'Accepted',
  rejected: 'Rejected',
  stale: 'Out of date',
  failed: 'No suggestion',
}

function StatusBadge({ suggestion }: { suggestion: Suggestion }) {
  const label =
    suggestion.status === 'working' && suggestion.phase ? suggestion.phase : STATUS_LABELS[suggestion.status]
  return (
    <span className={`ai-status ai-status-${suggestion.status}`}>
      {suggestion.status === 'working' && <span className="ai-spinner" aria-hidden="true" />}
      {label}
    </span>
  )
}

function ScoreBadge({ score }: { score: number }) {
  const level = score >= 0.85 ? 'high' : score >= 0.7 ? 'ok' : 'low'
  return (
    <span className={`ai-score ai-score-${level}`} title="Average of the checks, from 0 to 1">
      Score {score.toFixed(2)}
    </span>
  )
}

export function AiMark() {
  return (
    <svg className="ai-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 1.5l1.4 3.7 3.6 1.3-3.6 1.4L8 11.6 6.6 7.9 3 6.5l3.6-1.3L8 1.5zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z"
        fill="currentColor"
      />
    </svg>
  )
}

function describeSelection(text: Y.Text, { from, to }: Selection): string {
  const content = text.toString()
  const startLine = content.slice(0, from).split('\n').length
  const endLine = content.slice(0, to).split('\n').length
  if (startLine !== endLine) return `Selection: lines ${startLine} to ${endLine}`
  // Matches the server (server/src/ai/selection.ts): part of a line is
  // widened to the statement it belongs to, such as a whole function.
  const lineStart = content.lastIndexOf('\n', from - 1) + 1
  const lineEnd = content.indexOf('\n', to)
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
  const partial = line.trim() !== content.slice(from, to).trim()
  return partial
    ? `Selection: part of line ${startLine}, widened to the code it belongs to`
    : `Selection: line ${startLine}`
}
