import { useCallback, useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { fetchAiInfo, SUGGESTIONS_KEY, type AiInfo, type Suggestion } from './ai'

/** Every suggestion in the pad, oldest first, kept up to date from the shared document. */
export function useSuggestions(doc: Y.Doc): Suggestion[] {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  useEffect(() => {
    const map = doc.getMap<Suggestion>(SUGGESTIONS_KEY)
    const read = () =>
      setSuggestions([...map.values()].sort((a, b) => a.createdAt - b.createdAt))
    read()
    map.observe(read)
    return () => map.unobserve(read)
  }, [doc])

  return suggestions
}

/**
 * Whether the server has an AI set up, and how many requests are left.
 * Refreshed on demand (after asking, and when a request finishes).
 */
export function useAiInfo(roomId: string): [AiInfo | null, () => void] {
  const [info, setInfo] = useState<AiInfo | null>(null)

  const refresh = useCallback(() => {
    fetchAiInfo(roomId)
      .then(setInfo)
      .catch(() => {
        // Offline or the server is restarting; keep showing the last known state.
      })
  }, [roomId])

  useEffect(refresh, [refresh])
  return [info, refresh]
}
