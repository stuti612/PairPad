import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor } from '../components/Editor'
import { TopBar } from '../components/TopBar'
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
      />
      {connection.blocked && <StoppedBanner reason={connection.blocked} />}
      {!connection.blocked && atSizeLimit && (
        <div className="banner" role="status">
          This pad is at its size limit (about 1 MB). Delete something to make room.
        </div>
      )}
      <Editor
        text={session.text}
        awareness={session.provider.awareness}
        language={language}
        readOnly={connection.blocked !== null}
        onSizeLimit={flagSizeLimit}
      />
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
