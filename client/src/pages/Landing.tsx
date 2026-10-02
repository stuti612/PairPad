import { useState } from 'react'
import { createRoom, padPath } from '../lib/rooms'
import { navigate } from '../router'

export function Landing() {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHow, setShowHow] = useState(false)

  async function newPad() {
    setCreating(true)
    setError(null)
    try {
      navigate(padPath(await createRoom()))
    } catch {
      setError("Couldn't create a pad. Check your connection and try again.")
      setCreating(false)
    }
  }

  return (
    <main className="landing">
      <h1>PairPad</h1>
      <p className="tagline">
        A shared code scratchpad. Create a pad, send the link, and type together. No sign-up.
      </p>
      <button className="button button-primary" type="button" onClick={newPad} disabled={creating}>
        {creating ? 'Creating…' : 'New pad'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="link"
        type="button"
        aria-expanded={showHow}
        aria-controls="how-it-works"
        onClick={() => setShowHow((open) => !open)}
      >
        How it works
      </button>
      {showHow && (
        <p className="how" id="how-it-works">
          PairPad keeps the text in a CRDT (Yjs), which gives every character its own permanent ID
          and records each edit relative to the characters around it instead of at a line and
          column. Because of that, edits can arrive in any order, even after you have been offline,
          and every copy still ends up identical with nothing overwritten.
        </p>
      )}
    </main>
  )
}
