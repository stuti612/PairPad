import { Annotation, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { ySyncAnnotation } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { cleanColor, cleanName, FALLBACK_COLOR, FALLBACK_NAME } from './identity'

// Draws other people's cursors and selections, and publishes your own.
//
// y-codemirror.next ships a plugin for this, but it treats two cursor widgets
// as equal when only their colors match. A renamed user keeps their old name
// tag, and there is no way to replay the tag's fade-in for one person. This
// version uses the same awareness "cursor" field, so it stays compatible.

const CURSOR_FIELD = 'cursor'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

const remoteCursorsChanged = Annotation.define<boolean>()

class CaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
    /** Bumped whenever this person does something, so the name tag reappears. */
    readonly activity: number,
  ) {
    super()
  }

  eq(other: CaretWidget): boolean {
    return (
      other.color === this.color && other.name === this.name && other.activity === this.activity
    )
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span')
    caret.className = 'cm-remoteCaret'
    caret.style.borderColor = this.color
    const tag = document.createElement('span')
    tag.className = 'cm-remoteCaretTag'
    tag.style.backgroundColor = this.color
    tag.textContent = this.name
    // Word joiners keep the zero-width caret from becoming a line-break point.
    caret.append('⁠', tag, '⁠')
    return caret
  }

  ignoreEvent(): boolean {
    return true
  }
}

class RemoteCursors {
  decorations: DecorationSet = Decoration.none
  private readonly activity = new Map<number, number>()
  private tick = 0

  constructor(
    private readonly view: EditorView,
    private readonly text: Y.Text,
    private readonly awareness: Awareness,
  ) {
    awareness.on('change', this.onAwarenessChange)
    this.decorations = this.build()
  }

  destroy(): void {
    this.awareness.off('change', this.onAwarenessChange)
  }

  update(update: ViewUpdate): void {
    this.publishLocalCursor(update)
    this.decorations = this.build()
  }

  private onAwarenessChange = ({ added, updated, removed }: AwarenessChange): void => {
    const self = this.awareness.clientID
    let remoteChanged = false
    for (const clientId of [...added, ...updated]) {
      if (clientId === self) continue
      this.activity.set(clientId, (this.activity.get(clientId) ?? 0) + 1)
      remoteChanged = true
    }
    for (const clientId of removed) {
      this.activity.delete(clientId)
      if (clientId !== self) remoteChanged = true
    }
    // Our own change is handled in update(); dispatching here would re-enter it.
    if (remoteChanged) this.view.dispatch({ annotations: remoteCursorsChanged.of(true) })
  }

  private publishLocalCursor(update: ViewUpdate): void {
    const local = this.awareness.getLocalState()
    // Only a focused editor moves the shared cursor, so clicking elsewhere on
    // the page leaves your cursor where collaborators last saw it.
    if (!local || !update.view.hasFocus || !update.view.dom.ownerDocument.hasFocus()) return

    const { anchor, head } = update.state.selection.main
    const next = {
      anchor: Y.createRelativePositionFromTypeIndex(this.text, anchor),
      head: Y.createRelativePositionFromTypeIndex(this.text, head),
    }
    const current = local[CURSOR_FIELD] as { anchor?: unknown; head?: unknown } | undefined
    const unchanged =
      current?.anchor != null &&
      current.head != null &&
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor), next.anchor) &&
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), next.head)

    // A cursor at the very end of the text is stored as "end of text", which
    // does not change while you keep typing there. The tick makes sure every
    // edit or cursor move of yours still reaches the others as activity.
    // Changes applied from other people (ySyncAnnotation) do not count.
    const acted = update.transactions.some(
      (tr) => (tr.docChanged || tr.selection !== undefined) && !tr.annotation(ySyncAnnotation),
    )
    if (unchanged && !acted) return
    if (acted) this.tick++
    this.awareness.setLocalStateField(CURSOR_FIELD, { ...next, tick: this.tick })
  }

  private build(): DecorationSet {
    const doc = this.text.doc
    if (!doc) return Decoration.none
    const cmDoc = this.view.state.doc
    const decorations: Range<Decoration>[] = []

    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue
      const cursor = state[CURSOR_FIELD] as { anchor?: unknown; head?: unknown } | undefined
      if (cursor?.anchor == null || cursor.head == null) continue

      // Relative positions follow the text they were next to, so a cursor
      // stays put in the right place while other people edit around it.
      const anchor = toIndex(cursor.anchor, doc, this.text)
      const head = toIndex(cursor.head, doc, this.text)
      if (anchor === null || head === null) continue
      if (Math.max(anchor, head) > cmDoc.length) continue

      // Presence comes from other browsers, so it is cleaned before use.
      const user = (state as { user?: Record<string, unknown> }).user
      const color = cleanColor(user?.color) ?? FALLBACK_COLOR
      const name = cleanName(user?.name) ?? FALLBACK_NAME

      const from = Math.min(anchor, head)
      const to = Math.max(anchor, head)
      if (from !== to) {
        const style = `background-color: ${color}40`
        const firstLine = cmDoc.lineAt(from)
        const lastLine = cmDoc.lineAt(to)
        const mark = Decoration.mark({ class: 'cm-remoteSelection', attributes: { style } })
        if (firstLine.number === lastLine.number) {
          decorations.push(mark.range(from, to))
        } else {
          // Whole lines in between are highlighted as lines, so empty ones show too.
          if (from < firstLine.to) decorations.push(mark.range(from, firstLine.to))
          for (let n = firstLine.number + 1; n < lastLine.number; n++) {
            decorations.push(
              Decoration.line({ class: 'cm-remoteLineSelection', attributes: { style } }).range(
                cmDoc.line(n).from,
              ),
            )
          }
          if (lastLine.from < to) decorations.push(mark.range(lastLine.from, to))
        }
      }
      decorations.push(
        Decoration.widget({
          // Keep the caret outside the selection it ends.
          side: head > anchor ? -1 : 1,
          widget: new CaretWidget(color, name, this.activity.get(clientId) ?? 0),
        }).range(head),
      )
    }
    return Decoration.set(decorations, true)
  }
}

function toIndex(relative: unknown, doc: Y.Doc, text: Y.Text): number | null {
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(relative),
      doc,
    )
    return position && position.type === text ? position.index : null
  } catch {
    return null
  }
}

const theme = EditorView.baseTheme({
  '.cm-remoteCaret': {
    position: 'relative',
    borderLeft: '2px solid',
    marginLeft: '-1px',
    marginRight: '-1px',
  },
  // The tag covers part of the line above, so it shows for a moment when
  // that person does something and then fades. Hovering the caret shows it again.
  '@keyframes cm-remoteCaretTag': {
    '0%': { opacity: '1' },
    '80%': { opacity: '1' },
    '100%': { opacity: '0' },
  },
  '.cm-remoteCaretTag': {
    position: 'absolute',
    top: '-1.35em',
    left: '-2px',
    zIndex: '101',
    padding: '0 5px',
    borderRadius: '4px 4px 4px 0',
    color: '#0b1020',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: '11px',
    fontStyle: 'normal',
    fontWeight: '600',
    lineHeight: '1.5',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    // Never intercept clicks meant for the text underneath.
    pointerEvents: 'none',
    opacity: '0',
    animation: 'cm-remoteCaretTag 2.5s ease-out',
  },
  '.cm-remoteCaret:hover > .cm-remoteCaretTag': { opacity: '1', animation: 'none' },
})

export function remoteCursors(text: Y.Text, awareness: Awareness): Extension {
  return [
    theme,
    ViewPlugin.define((view) => new RemoteCursors(view, text, awareness), {
      decorations: (plugin) => plugin.decorations,
    }),
  ]
}
