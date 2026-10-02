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
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { editorTheme } from '../lib/editorTheme'
import { languageExtension, type LanguageId } from '../lib/languages'
import { remoteCursors } from '../lib/remoteCursors'
import { sizeLimit } from '../lib/sizeLimit'

interface EditorProps {
  text: Y.Text
  awareness: Awareness
  language: LanguageId
  readOnly: boolean
  /** Called when an edit of yours was blocked because the pad is full. */
  onSizeLimit: () => void
}

const readOnlyExtension = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
]

export function Editor({ text, awareness, language, readOnly, onSizeLimit }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const languageConf = useRef(new Compartment())
  const initialLanguage = useRef(language)
  const readOnlyConf = useRef(new Compartment())
  const initialReadOnly = useRef(readOnly)
  const sizeLimitHandler = useRef(onSizeLimit)
  sizeLimitHandler.current = onSizeLimit

  useEffect(() => {
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
          sizeLimit(() => sizeLimitHandler.current()),
          editorTheme,
          // y-codemirror.next binds the editor to the shared text and provides
          // undo; passing no awareness turns off its own cursor drawing in
          // favor of ours (see remoteCursors.ts for why).
          yCollab(text, null),
          remoteCursors(text, awareness),
        ],
      }),
    })
    view.current = editor
    editor.focus()
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [text, awareness])

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

  return <div className="editor" ref={host} />
}
