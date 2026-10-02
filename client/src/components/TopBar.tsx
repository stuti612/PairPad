import { useEffect, useRef, useState } from 'react'
import { LANGUAGES, type LanguageId } from '../lib/languages'
import type { ConnectionStatus } from '../lib/useConnection'
import type { Presence } from '../lib/usePresence'
import { onLinkClick } from '../router'
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
}

export function TopBar({
  roomId,
  language,
  onLanguageChange,
  presence,
  status,
  unsynced,
  stopped,
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
