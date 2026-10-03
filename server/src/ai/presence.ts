import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { Room } from '../room.js'

export const AI_NAME = 'PairPad AI'
// Outside the palette people choose from, so the AI never looks like a person.
export const AI_COLOR = '#e2e8f0'
const AI_ORIGIN = 'pairpad-ai'

/**
 * The AI's presence in a room: its own awareness client, with a name, a
 * color and a cursor, shown to everyone exactly like a person's.
 *
 * It has its own client ID (from a private Y.Doc) and its changes are fed
 * into the room's awareness, which relays them to every connection. It is
 * not a socket, so it never counts toward the room's user limit.
 */
export class AiPresence {
  private readonly awareness = new awarenessProtocol.Awareness(new Y.Doc())
  private tick = 0

  constructor(private readonly room: Room) {
    // Also forwards the periodic renewals the awareness sends on its own,
    // which keep the AI from timing out of other people's lists.
    this.awareness.on('update', this.forward)
  }

  /** Shows the AI in the room, with its cursor over `from`..`to` of the shared text. */
  show(text: Y.Text, from: number, to: number, activity: string): void {
    this.awareness.setLocalState({
      user: { name: AI_NAME, color: AI_COLOR, colorPicked: true, ai: true },
      // Same shape as a person's cursor, so clients draw it the same way.
      cursor: {
        anchor: Y.createRelativePositionFromTypeIndex(text, from),
        head: Y.createRelativePositionFromTypeIndex(text, to),
        tick: this.tick++,
      },
      activity,
    })
  }

  leave(): void {
    this.awareness.setLocalState(null)
    this.awareness.off('update', this.forward)
    this.awareness.destroy()
  }

  private forward = ({ added, updated, removed }: Record<string, number[]>): void => {
    const changed = [...added!, ...updated!, ...removed!]
    awarenessProtocol.applyAwarenessUpdate(
      this.room.awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      AI_ORIGIN,
    )
  }
}
