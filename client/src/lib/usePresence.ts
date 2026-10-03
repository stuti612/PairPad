import { useCallback, useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import {
  cleanColor,
  cleanName,
  FALLBACK_COLOR,
  FALLBACK_NAME,
  freeColor,
  loadIdentity,
  saveIdentity,
  type Identity,
} from './identity'

// Awareness field read by y-codemirror.next to draw remote cursors.
const USER_FIELD = 'user'

export interface Peer {
  clientId: number
  name: string
  color: string
  colorPicked: boolean
  isSelf: boolean
  /** PairPad AI, which joins while it works on a request. */
  isAi: boolean
}

export interface Presence {
  me: Identity
  /** Everyone in the room, yourself first. */
  peers: Peer[]
  updateMe: (patch: { name?: string; color?: string }) => void
}

function readPeers(awareness: Awareness): Peer[] {
  const peers: Peer[] = []
  for (const [clientId, state] of awareness.getStates()) {
    const user = (state as { user?: Record<string, unknown> })[USER_FIELD]
    // A client that has connected but not announced itself yet is not listed.
    if (!user || typeof user !== 'object') continue
    peers.push({
      clientId,
      name: cleanName(user.name) ?? FALLBACK_NAME,
      color: cleanColor(user.color) ?? FALLBACK_COLOR,
      colorPicked: user.colorPicked === true,
      isAi: user.ai === true,
      isSelf: clientId === awareness.clientID,
    })
  }
  return peers.sort(
    (a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId,
  )
}

/**
 * If your color was assigned at random and someone else has the same one,
 * move to a free color. Of two people with random colors only the one with
 * the higher client ID moves, so they do not both jump at once.
 */
function avoidColorClash(me: Identity, peers: Peer[], selfId: number): Identity {
  if (me.colorPicked) return me
  const others = peers.filter((peer) => !peer.isSelf)
  const mustYield = others.some(
    (peer) => peer.color === me.color && (peer.colorPicked || peer.clientId < selfId),
  )
  if (!mustYield) return me
  const color = freeColor(new Set(others.map((peer) => peer.color)))
  return color ? { ...me, color } : me
}

/** Publishes your name and color to the room and tracks who else is in it. */
export function usePresence(awareness: Awareness): Presence {
  const [me, setMe] = useState<Identity>(loadIdentity)
  const [peers, setPeers] = useState<Peer[]>([])

  useEffect(() => {
    awareness.setLocalStateField(USER_FIELD, {
      name: me.name,
      color: me.color,
      // Translucent version of the color, used for the selection highlight.
      colorLight: `${me.color}40`,
      colorPicked: me.colorPicked,
    })
    saveIdentity(me)
  }, [awareness, me])

  useEffect(() => {
    const update = () => {
      const next = readPeers(awareness)
      setPeers(next)
      setMe((current) => avoidColorClash(current, next, awareness.clientID))
    }
    update()
    awareness.on('change', update)
    return () => awareness.off('change', update)
  }, [awareness])

  const updateMe = useCallback((patch: { name?: string; color?: string }) => {
    setMe((current) => {
      const color = cleanColor(patch.color)
      return {
        name: cleanName(patch.name) ?? current.name,
        color: color ?? current.color,
        colorPicked: current.colorPicked || color !== null,
      }
    })
  }, [])

  return { me, peers, updateMe }
}
