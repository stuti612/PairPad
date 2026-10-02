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

interface EditorProps {
  text: Y.Text
  awareness: Awareness
  language: LanguageId
}

export function Editor({ text, awareness, language }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const languageConf = useRef(new Compartment())
  const initialLanguage = useRef(language)

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

  return <div className="editor" ref={host} />
}
