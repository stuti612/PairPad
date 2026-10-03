import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import * as Y from 'yjs'
import type { Suggestion } from './ai'
import { diffLines, splitLines } from './lineDiff'

// Shows each open AI suggestion inline: the lines it removes struck through
// in red, the lines it adds in green beneath them, and a bar with Accept and
// Reject above. Everyone in the pad sees the same diffs.

export interface DiffHandlers {
  accept: (id: string) => void
  reject: (id: string) => void
}

interface Item {
  suggestion: Suggestion
  from: number
  to: number
}

/** Replaces the suggestions shown, with ranges already resolved to positions. */
const setItems = StateEffect.define<Item[]>()

/**
 * Builds the extension. `text` is the shared Y.Text the editor is bound to;
 * call the returned `show` whenever the list of suggestions changes.
 */
export function suggestionDiffs(
  text: Y.Text,
  handlers: DiffHandlers,
): { extension: Extension; show: (view: EditorView, suggestions: Suggestion[]) => void } {
  const field = StateField.define<{ items: Item[]; decorations: DecorationSet }>({
    create: () => ({ items: [], decorations: Decoration.none }),
    update(value, tr) {
      let items = value.items
      for (const effect of tr.effects) {
        if (effect.is(setItems)) items = effect.value
      }
      if (items === value.items && !tr.docChanged) return value
      if (items === value.items) {
        // Follow the code through edits. Typing right at either edge stays
        // outside the range, as on the server.
        items = items.map((item) => {
          const from = tr.changes.mapPos(item.from, 1)
          const to = Math.max(from, tr.changes.mapPos(item.to, -1))
          return { ...item, from, to }
        })
      }
      return { items, decorations: build(items, tr.state.doc, handlers) }
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  })

  const show = (view: EditorView, suggestions: Suggestion[]) => {
    const doc = text.doc
    if (!doc) return
    const items: Item[] = []
    for (const suggestion of suggestions) {
      if (suggestion.status !== 'pending' && suggestion.status !== 'stale') continue
      const start = toIndex(doc, text, suggestion.range.start)
      const end = toIndex(doc, text, suggestion.range.end)
      if (start === null || end === null) continue
      const from = Math.min(start, end)
      const to = Math.max(start, end)
      if (to > view.state.doc.length) continue
      items.push({ suggestion, from, to })
    }
    view.dispatch({ effects: setItems.of(items) })
  }

  return { extension: [field, theme], show }
}

function build(items: Item[], doc: EditorView['state']['doc'], handlers: DiffHandlers): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const { suggestion, from, to } of items) {
    const current =
      suggestion.status === 'pending' && doc.sliceString(from, to) === suggestion.originalText
    ranges.push(
      Decoration.widget({
        widget: new HeaderWidget(suggestion, current, handlers),
        block: true,
        side: -2,
      }).range(from),
    )
    if (!current) {
      if (to > from) ranges.push(staleMark.range(from, to))
      continue
    }

    const original = splitLines(suggestion.originalText)
    const offsets: number[] = []
    let offset = from
    for (const line of original) {
      offsets.push(offset)
      offset += line.length + 1
    }
    let added: string[] = []
    let index = 0
    const flush = (position: number, side: number) => {
      if (added.length === 0) return
      ranges.push(Decoration.widget({ widget: new AddedLines(added), block: true, side }).range(position))
      added = []
    }
    for (const op of diffLines(original, splitLines(suggestion.proposedText))) {
      if (op.type === 'added') {
        added.push(op.line)
        continue
      }
      const start = offsets[index]!
      if (op.type === 'same') {
        flush(start, -1)
      } else if (op.line.length > 0) {
        ranges.push(removedMark.range(start, start + op.line.length))
      } else {
        ranges.push(removedLine.range(doc.lineAt(start).from))
      }
      index++
    }
    flush(to, 1)
  }
  return Decoration.set(ranges, true)
}

const removedMark = Decoration.mark({ class: 'cm-ai-removed' })
const removedLine = Decoration.line({ class: 'cm-ai-removed-line' })
const staleMark = Decoration.mark({ class: 'cm-ai-stale' })

class AddedLines extends WidgetType {
  constructor(readonly lines: string[]) {
    super()
  }

  eq(other: AddedLines): boolean {
    return other.lines.join('\n') === this.lines.join('\n')
  }

  toDOM(): HTMLElement {
    const block = document.createElement('div')
    block.className = 'cm-ai-added'
    block.setAttribute('aria-label', 'Lines the AI suggests adding')
    for (const line of this.lines) {
      const row = document.createElement('div')
      row.className = 'cm-ai-added-line'
      row.textContent = line === '' ? '​' : line
      block.append(row)
    }
    return block
  }

  ignoreEvent(): boolean {
    return true
  }
}

class HeaderWidget extends WidgetType {
  constructor(
    readonly suggestion: Suggestion,
    readonly current: boolean,
    readonly handlers: DiffHandlers,
  ) {
    super()
  }

  eq(other: HeaderWidget): boolean {
    return (
      other.suggestion.id === this.suggestion.id &&
      other.suggestion.status === this.suggestion.status &&
      other.suggestion.score === this.suggestion.score &&
      other.current === this.current
    )
  }

  toDOM(): HTMLElement {
    const { suggestion, current, handlers } = this
    const bar = document.createElement('div')
    bar.className = `cm-ai-header${current ? '' : ' cm-ai-header-stale'}`
    bar.dataset.suggestion = suggestion.id

    const label = document.createElement('span')
    label.className = 'cm-ai-header-label'
    label.textContent = current
      ? `PairPad AI: ${suggestion.summary || suggestion.instruction}`
      : 'PairPad AI: this suggestion is out of date because the code changed.'
    bar.append(label)

    if (current && suggestion.score !== null) {
      const score = document.createElement('span')
      score.className = 'cm-ai-header-score'
      score.textContent = `Score ${suggestion.score.toFixed(2)}`
      bar.append(score)
    }

    const button = (text: string, className: string, onClick: () => void) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = className
      element.textContent = text
      element.addEventListener('mousedown', (event) => event.preventDefault())
      element.addEventListener('click', onClick)
      return element
    }
    if (current) bar.append(button('Accept', 'cm-ai-accept', () => handlers.accept(suggestion.id)))
    bar.append(
      button(current ? 'Reject' : 'Dismiss', 'cm-ai-reject', () => handlers.reject(suggestion.id)),
    )
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}

function toIndex(doc: Y.Doc, text: Y.Text, relative: unknown): number | null {
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
  '.cm-ai-removed': {
    backgroundColor: 'rgba(248, 113, 113, 0.22)',
    textDecoration: 'line-through',
    textDecorationColor: 'rgba(248, 113, 113, 0.7)',
  },
  '.cm-ai-removed-line': { backgroundColor: 'rgba(248, 113, 113, 0.12)' },
  '.cm-ai-stale': {
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    outline: '1px dashed rgba(251, 191, 36, 0.5)',
  },
  '.cm-ai-added': {
    margin: '0',
    padding: '0 16px 0 8px',
    backgroundColor: 'rgba(52, 211, 153, 0.14)',
    borderLeft: '3px solid rgba(52, 211, 153, 0.8)',
    color: '#d1fae5',
    whiteSpace: 'pre',
    fontFamily: 'inherit',
  },
  '.cm-ai-added-line::before': { content: '"+ "', color: 'rgba(52, 211, 153, 0.9)' },
  '.cm-ai-header': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '6px 0 2px',
    padding: '4px 8px',
    borderRadius: '6px',
    backgroundColor: 'rgba(226, 232, 240, 0.08)',
    border: '1px solid rgba(226, 232, 240, 0.18)',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: '12px',
    color: '#e2e8f0',
  },
  '.cm-ai-header-stale': { borderColor: 'rgba(251, 191, 36, 0.45)', color: '#fde68a' },
  '.cm-ai-header-label': {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-ai-header-score': { color: '#9aa0b2' },
  '.cm-ai-header button': {
    height: '22px',
    padding: '0 9px',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    borderRadius: '5px',
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#e6e8ee',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-ai-header button:disabled': { opacity: '0.5', cursor: 'default' },
  '.cm-ai-header .cm-ai-accept': {
    borderColor: 'transparent',
    background: '#34d399',
    color: '#06281c',
    fontWeight: '600',
  },
})
