import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AiPanel, type Selection } from '../components/AiPanel'
import { Editor, type EditorHandle } from '../components/Editor'
import { TopBar } from '../components/TopBar'
import { decideSuggestion } from '../lib/ai'
import { useAiInfo, useSuggestions } from '../lib/useSuggestions'
import { useConnection, type Blocked } from '../lib/useConnection'
import { usePad, useSharedLanguage, type PadSession } from '../lib/usePad'
import { usePresence } from '../lib/usePresence'
import { onLinkClick } from '../router'

export function Pad({ roomId }: { roomId: string }) {
  const session = usePad(roomId)

  useEffect(() => {
    document.title = `${roomId} · PairPad`
    return () => {
      document.title = 'PairPad'
    }
  }, [roomId])

  if (!session) return <div className="pad" />
  return <PadView roomId={roomId} session={session} />
}

function PadView({ roomId, session }: { roomId: string; session: PadSession }) {
  const [language, setLanguage] = useSharedLanguage(session.meta)
  const presence = usePresence(session.provider.awareness)
  const connection = useConnection(session)
  const [atSizeLimit, flagSizeLimit] = useTransientFlag(5000)
  const [aiOpen, setAiOpen] = useRememberedFlag('pairpad:ai-panel-open')
  const [aiInfo, refreshAi] = useAiInfo(roomId)
  const suggestions = useSuggestions(session.doc)
  const [selection, setSelection] = useState<Selection>({ from: 0, to: 0 })
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const editor = useRef<EditorHandle>(null)
  const connected = connection.status === 'connected'
  const me = presence.me.name

  const openSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.status === 'pending' || suggestion.status === 'stale'),
    [suggestions],
  )

  // Accept and Reject from the bar drawn inside the editor.
  const diffHandlers = useMemo(() => {
    const decide = (id: string, action: 'accept' | 'reject') => {
      setDecisionError(null)
      decideSuggestion(roomId, id, action, me).catch((error: Error) => setDecisionError(error.message))
    }
    return {
      accept: (id: string) => decide(id, 'accept'),
      reject: (id: string) => decide(id, 'reject'),
    }
  }, [roomId, me])

  useEffect(() => {
    if (!decisionError) return
    const timer = window.setTimeout(() => setDecisionError(null), 6000)
    return () => window.clearTimeout(timer)
  }, [decisionError])

  if (connection.blocked === 'room-full') {
    return (
      <div className="pad">
        <header className="topbar">
          <a className="brand" href="/" onClick={onLinkClick}>
            PairPad
          </a>
          <span className="room-id">{roomId}</span>
        </header>
        <main className="notice-page">
          <h1>This pad is full</h1>
          <p>A pad holds up to 10 people at a time. Try again once someone has left.</p>
          <div className="notice-actions">
            <button className="button button-primary" type="button" onClick={connection.retry}>
              Try again
            </button>
            <a className="button button-secondary" href="/" onClick={onLinkClick}>
              Start a new pad
            </a>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="pad">
      <TopBar
        roomId={roomId}
        language={language}
        onLanguageChange={setLanguage}
        presence={presence}
        status={connection.status}
        unsynced={connection.unsynced}
        stopped={connection.blocked !== null}
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen(!aiOpen)}
        openSuggestions={openSuggestions.length}
      />
      {connection.blocked && <StoppedBanner reason={connection.blocked} />}
      {!connection.blocked && atSizeLimit && (
        <div className="banner" role="status">
          This pad is at its size limit (about 1 MB). Delete something to make room.
        </div>
      )}
      {decisionError && (
        <div className="banner banner-error" role="alert">
          {decisionError}
        </div>
      )}
      <div className="pad-body">
        <Editor
          ref={editor}
          text={session.text}
          awareness={session.provider.awareness}
          language={language}
          readOnly={connection.blocked !== null}
          onSizeLimit={flagSizeLimit}
          suggestions={openSuggestions}
          diffHandlers={diffHandlers}
          onSelectionChange={setSelection}
        />
        {aiOpen && (
          <AiPanel
            roomId={roomId}
            text={session.text}
            info={aiInfo}
            onInfoChange={refreshAi}
            suggestions={suggestions}
            selection={selection}
            author={me}
            connected={connected}
            onClose={() => setAiOpen(false)}
            onFocusSuggestion={(suggestion) => editor.current?.reveal(suggestion)}
          />
        )}
      </div>
    </div>
  )
}

function StoppedBanner({ reason }: { reason: Exclude<Blocked, 'room-full'> }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>
        {reason === 'too-large'
          ? 'This pad has reached its 1 MB size limit, so your last change could not be saved. Reload to carry on from the saved version.'
          : 'The server closed the connection because of an unexpected problem, so your latest changes may not be saved. Reload to reconnect.'}
      </span>
      <button className="button" type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  )
}

/** A per-viewer on/off setting remembered in this browser. */
function useRememberedFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const update = useCallback(
    (next: boolean) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Not remembering a panel's state is fine.
      }
    },
    [key],
  )
  return [value, update]
}

/** A flag that turns itself off again after `durationMs`. */
function useTransientFlag(durationMs: number): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<number>()

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const raise = useCallback(() => {
    setOn(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOn(false), durationMs)
  }, [durationMs])

  return [on, raise]
}
