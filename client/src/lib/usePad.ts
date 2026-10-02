import { useCallback, useEffect, useState } from 'react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { DEFAULT_LANGUAGE, isLanguageId, type LanguageId } from './languages'
import { websocketBaseUrl } from './rooms'
import { isPermanentClose } from './useConnection'

// Shared type names inside the Y.Doc. TEXT_KEY must match server/src/protocol.ts.
const TEXT_KEY = 'content'
const META_KEY = 'meta'
const LANGUAGE_FIELD = 'language'

export interface PadSession {
  doc: Y.Doc
  provider: WebsocketProvider
  text: Y.Text
  meta: Y.Map<unknown>
}

/** Opens the shared document for a room and keeps it connected while mounted. */
export function usePad(roomId: string): PadSession | null {
  const [session, setSession] = useState<PadSession | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    // The provider reconnects by itself with backoff (at most 2.5 s apart)
    // and re-syncs both ways, which is what merges edits made while offline.
    const provider = new WebsocketProvider(websocketBaseUrl(), roomId, doc, {
      shouldReconnect: (event) => !isPermanentClose(event.code),
    })
    setSession({ doc, provider, text: doc.getText(TEXT_KEY), meta: doc.getMap(META_KEY) })
    return () => {
      provider.destroy()
      doc.destroy()
      setSession(null)
    }
  }, [roomId])

  return session
}

/** The room's language lives in the shared document, so picking one changes it for everyone. */
export function useSharedLanguage(
  meta: Y.Map<unknown>,
): [LanguageId, (language: LanguageId) => void] {
  const read = useCallback((): LanguageId => {
    const value = meta.get(LANGUAGE_FIELD)
    return isLanguageId(value) ? value : DEFAULT_LANGUAGE
  }, [meta])

  const [language, setLanguage] = useState<LanguageId>(read)

  useEffect(() => {
    const onChange = () => setLanguage(read())
    onChange()
    meta.observe(onChange)
    return () => meta.unobserve(onChange)
  }, [meta, read])

  const change = useCallback(
    (next: LanguageId) => {
      meta.set(LANGUAGE_FIELD, next)
    },
    [meta],
  )

  return [language, change]
}
