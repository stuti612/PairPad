import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { Suggestion } from '../lib/ai'
import { editorTheme } from '../lib/editorTheme'
import { languageExtension, type LanguageId } from '../lib/languages'
import { remoteCursors } from '../lib/remoteCursors'
import { sizeLimit } from '../lib/sizeLimit'
import { suggestionDiffs, type DiffHandlers } from '../lib/suggestionDiffs'

interface EditorProps {
  text: Y.Text
  awareness: Awareness
  language: LanguageId
  readOnly: boolean
  /** Called when an edit of yours was blocked because the pad is full. */
  onSizeLimit: () => void
  /** Open AI suggestions, drawn inline as diffs. */
  suggestions: Suggestion[]
  /** Accept and Reject from the inline suggestion bar. */
  diffHandlers: DiffHandlers
  /** Your main selection, in the shared text's positions. */
  onSelectionChange: (selection: { from: number; to: number }) => void
}

export interface EditorHandle {
  /** Scrolls to a suggestion and puts the cursor at its start. */
  reveal: (suggestion: Suggestion) => void
}

const readOnlyExtension = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
]

export const Editor = memo(
  forwardRef<EditorHandle, EditorProps>(function Editor(
    { text, awareness, language, readOnly, onSizeLimit, suggestions, diffHandlers, onSelectionChange },
    ref,
  ) {
    const host = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    const languageConf = useRef(new Compartment())
    const initialLanguage = useRef(language)
    const readOnlyConf = useRef(new Compartment())
    const initialReadOnly = useRef(readOnly)
    // Callbacks change on every render; the editor reads the latest through refs.
    const latest = useRef({ onSizeLimit, diffHandlers, onSelectionChange, suggestions })
    latest.current = { onSizeLimit, diffHandlers, onSelectionChange, suggestions }
    const showDiffs = useRef<((view: EditorView, suggestions: Suggestion[]) => void) | null>(null)

    useEffect(() => {
      const diffs = suggestionDiffs(text, {
        accept: (id) => latest.current.diffHandlers.accept(id),
        reject: (id) => latest.current.diffHandlers.reject(id),
        rerun: (id) => latest.current.diffHandlers.rerun(id),
      })
      const editor = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: text.toString(),
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            rectangularSelection(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            placeholder('Start typing. Anyone with the link sees it live.'),
            // Long lines wrap instead of running off the edge (the AI panel
            // narrows the editor).
            EditorView.lineWrapping,
            // Undo comes from Yjs (yUndoManagerKeymap) rather than CodeMirror's
            // own history, so Ctrl+Z only undoes your edits, never a collaborator's.
            keymap.of([
              ...closeBracketsKeymap,
              ...yUndoManagerKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              indentWithTab,
            ]),
            languageConf.current.of(languageExtension(initialLanguage.current)),
            readOnlyConf.current.of(readOnlyExtension(initialReadOnly.current)),
            sizeLimit(() => latest.current.onSizeLimit()),
            editorTheme,
            // y-codemirror.next binds the editor to the shared text and provides
            // undo; passing no awareness turns off its own cursor drawing in
            // favor of ours (see remoteCursors.ts for why).
            yCollab(text, null),
            remoteCursors(text, awareness),
            diffs.extension,
            EditorView.updateListener.of((update) => {
              if (update.selectionSet || update.docChanged) {
                const { from, to } = update.state.selection.main
                latest.current.onSelectionChange({ from, to })
              }
            }),
          ],
        }),
      })
      view.current = editor
      showDiffs.current = diffs.show
      diffs.show(editor, latest.current.suggestions)
      editor.focus()
      return () => {
        editor.destroy()
        view.current = null
        showDiffs.current = null
      }
    }, [text, awareness])

    useEffect(() => {
      if (view.current) showDiffs.current?.(view.current, suggestions)
    }, [suggestions])

    useEffect(() => {
      view.current?.dispatch({
        effects: languageConf.current.reconfigure(languageExtension(language)),
      })
    }, [language])

    useEffect(() => {
      view.current?.dispatch({
        effects: readOnlyConf.current.reconfigure(readOnlyExtension(readOnly)),
      })
    }, [readOnly])

    useImperativeHandle(
      ref,
      () => ({
        reveal(suggestion) {
          const editor = view.current
          const doc = text.doc
          if (!editor || !doc) return
          const position = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(suggestion.range.start),
            doc,
          )
          if (!position || position.index > editor.state.doc.length) return
          editor.dispatch({
            selection: { anchor: position.index },
            effects: EditorView.scrollIntoView(position.index, { y: 'center' }),
          })
          editor.focus()
        },
      }),
      [text],
    )

    return <div className="editor" ref={host} />
  }),
)
