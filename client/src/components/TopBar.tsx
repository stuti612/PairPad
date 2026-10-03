import { useEffect, useRef, useState } from 'react'
import { LANGUAGES, type LanguageId } from '../lib/languages'
import type { ConnectionStatus } from '../lib/useConnection'
import type { Presence } from '../lib/usePresence'
import { onLinkClick } from '../router'
import { AiMark } from './AiPanel'
import { PresenceMenu } from './PresenceMenu'
import { StatusBadge } from './StatusBadge'

interface TopBarProps {
  roomId: string
  language: LanguageId
  onLanguageChange: (language: LanguageId) => void
  presence: Presence
  status: ConnectionStatus
  unsynced: boolean
  /** The server refused this session for good; the badge would only mislead. */
  stopped: boolean
  aiOpen: boolean
  onToggleAi: () => void
  /** Suggestions waiting for a decision. */
  openSuggestions: number
}

export function TopBar({
  roomId,
  language,
  onLanguageChange,
  presence,
  status,
  unsynced,
  stopped,
  aiOpen,
  onToggleAi,
  openSuggestions,
}: TopBarProps) {
  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={onLinkClick}>
        PairPad
      </a>
      <span className="room-id" title="Room ID">
        {roomId}
      </span>
      <CopyLinkButton />
      <div className="topbar-spacer" />
      {!stopped && <StatusBadge status={status} unsynced={unsynced} />}
      <PresenceMenu {...presence} />
      <button
        className={`button button-ai-toggle${aiOpen ? ' is-active' : ''}`}
        type="button"
        aria-pressed={aiOpen}
        onClick={onToggleAi}
      >
        <AiMark />
        Ask AI
        {openSuggestions > 0 && (
          <span className="ai-count" aria-label={`${openSuggestions} open suggestions`}>
            {openSuggestions}
          </span>
        )}
      </button>
      <label className="language-picker">
        <span className="visually-hidden">Language</span>
        <select
          value={language}
          onChange={(event) => onLanguageChange(event.target.value as LanguageId)}
        >
          {LANGUAGES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </header>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'

function CopyLinkButton() {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<number>()

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  async function copy() {
    let next: CopyState = 'copied'
    try {
      await navigator.clipboard.writeText(window.location.href)
    } catch {
      // Clipboard access is blocked on insecure origins and in some embeds.
      next = 'failed'
    }
    setState(next)
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState('idle'), 2000)
  }

  return (
    <button className="button" type="button" onClick={copy}>
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy from address bar' : 'Copy link'}
      </span>
    </button>
  )
}
