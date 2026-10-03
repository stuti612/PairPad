import { useEffect, useId, useRef, useState } from 'react'
import { COLORS, initials, MAX_NAME_LENGTH } from '../lib/identity'
import type { Peer, Presence } from '../lib/usePresence'

const MAX_AVATARS = 4

export function PresenceMenu({ me, peers, updateMe }: Presence) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const shown = peers.slice(0, MAX_AVATARS)
  const hidden = peers.length - shown.length
  const people = peers.filter((peer) => !peer.isAi).length
  const aiHere = peers.some((peer) => peer.isAi)
  const summary = `${people} ${people === 1 ? 'person' : 'people'} here${aiHere ? ', plus PairPad AI' : ''}`

  return (
    <div className="presence" ref={root}>
      <button
        className="presence-toggle"
        type="button"
        aria-label={summary}
        aria-expanded={open}
        aria-controls={panelId}
        title={summary}
        onClick={() => setOpen((value) => !value)}
      >
        {shown.map((peer) => (
          <Avatar key={peer.clientId} peer={peer} />
        ))}
        {hidden > 0 && <span className="avatar avatar-more">+{hidden}</span>}
      </button>
      {open && (
        <div className="presence-panel" id={panelId}>
          <h2>Who's here ({people})</h2>
          <ul className="presence-list">
            {peers.map((peer) => (
              <li key={peer.clientId}>
                <Avatar peer={peer} />
                <span className="presence-name">{peer.name}</span>
                {peer.isSelf && <span className="presence-you">you</span>}
                {peer.isAi && <span className="presence-you">AI</span>}
              </li>
            ))}
          </ul>
          <IdentityForm me={me} updateMe={updateMe} />
        </div>
      )}
    </div>
  )
}

function Avatar({ peer }: { peer: Peer }) {
  return (
    <span
      className={`avatar${peer.isAi ? ' avatar-ai' : ''}`}
      style={{ backgroundColor: peer.color }}
      aria-hidden="true"
    >
      {peer.isAi ? 'AI' : initials(peer.name)}
    </span>
  )
}

function IdentityForm({ me, updateMe }: Pick<Presence, 'me' | 'updateMe'>) {
  // The draft holds exactly what was typed (including a trailing space or an
  // empty field); the shared name only changes once the draft is usable.
  const [draft, setDraft] = useState(me.name)

  return (
    <div className="identity-form">
      <label>
        <span>Your name</span>
        <input
          type="text"
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            updateMe({ name: event.target.value })
          }}
          onBlur={() => setDraft(me.name)}
        />
      </label>
      <div role="radiogroup" aria-label="Your color" className="swatches">
        {COLORS.map(({ name, value }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={me.color === value}
            aria-label={name}
            title={name}
            className="swatch"
            style={{ backgroundColor: value }}
            onClick={() => updateMe({ color: value })}
          />
        ))}
      </div>
    </div>
  )
}
