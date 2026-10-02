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
import type * as Y from 'yjs'
import { editorTheme } from '../lib/editorTheme'
import { languageExtension, type LanguageId } from '../lib/languages'

interface EditorProps {
  text: Y.Text
  language: LanguageId
}

export function Editor({ text, language }: EditorProps) {
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
          yCollab(text, null),
        ],
      }),
    })
    view.current = editor
    editor.focus()
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [text])

  useEffect(() => {
    view.current?.dispatch({
      effects: languageConf.current.reconfigure(languageExtension(language)),
    })
  }, [language])

  return <div className="editor" ref={host} />
}
