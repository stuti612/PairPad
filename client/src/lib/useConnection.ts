import { useCallback, useEffect, useState } from 'react'
import type { PadSession } from './usePad'

// Close codes sent by the server (see server/src/protocol.ts).
const CLOSE_TOO_LARGE = 4413
const CLOSE_ROOM_FULL = 4429
// Standard WebSocket code for a single message over the server's frame limit.
const CLOSE_MESSAGE_TOO_BIG = 1009

// How long to keep saying "Reconnecting" before calling it "Offline".
const STALLED_AFTER_MS = 8000

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

/** Why the server refused us for good. Nothing is retried until the person acts. */
export type Blocked = 'room-full' | 'too-large' | 'error'

export interface Connection {
  status: ConnectionStatus
  blocked: Blocked | null
  /** True while edits made without a connection are waiting to be sent. */
  unsynced: boolean
  /** Try again after being turned away from a full room. */
  retry: () => void
}

/** A close the provider should not answer by reconnecting. */
export function isPermanentClose(code: number): boolean {
  return (code >= 4400 && code < 4500) || code === CLOSE_MESSAGE_TOO_BIG
}

export function useConnection({ provider, doc }: PadSession): Connection {
  const [connected, setConnected] = useState(provider.wsconnected)
  const [everConnected, setEverConnected] = useState(provider.wsconnected)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [stalled, setStalled] = useState(false)
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const [unsynced, setUnsynced] = useState(false)

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => {
      const isConnected = status === 'connected'
      setConnected(isConnected)
      if (isConnected) setEverConnected(true)
    }
    const onClosed = ({ code }: { code: number }) => {
      if (code === CLOSE_ROOM_FULL) setBlocked('room-full')
      else if (code === CLOSE_TOO_LARGE || code === CLOSE_MESSAGE_TOO_BIG) setBlocked('too-large')
      else setBlocked('error')
    }
    // Edits made while disconnected live only in this tab until the next sync.
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== provider && !provider.wsconnected) setUnsynced(true)
    }
    const onSync = (synced: boolean) => {
      if (synced) setUnsynced(false)
    }
    // Catch up in case the socket opened before this effect ran.
    if (provider.wsconnected) onStatus({ status: 'connected' })
    provider.on('status', onStatus)
    provider.on('closed', onClosed)
    provider.on('sync', onSync)
    doc.on('update', onUpdate)
    return () => {
      provider.off('status', onStatus)
      provider.off('closed', onClosed)
      provider.off('sync', onSync)
      doc.off('update', onUpdate)
    }
  }, [provider, doc])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // The browser's own "online" flag stays true on Wi-Fi with no internet, or
  // when only our server is unreachable, so a long outage also counts.
  useEffect(() => {
    if (connected) {
      setStalled(false)
      return
    }
    const timer = window.setTimeout(() => setStalled(true), STALLED_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [connected])

  // Closing the tab now would throw away edits nobody else has received.
  useEffect(() => {
    if (!unsynced) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsynced])

  const retry = useCallback(() => {
    setBlocked(null)
    provider.connect()
  }, [provider])

  let status: ConnectionStatus
  if (connected) status = 'connected'
  else if (!online || stalled) status = 'offline'
  else if (everConnected) status = 'reconnecting'
  else status = 'connecting'

  return { status, blocked, unsynced, retry }
}
