import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Colours mirror the CSS variables in styles.css.
const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text)',
      backgroundColor: 'var(--bg)',
      fontSize: '14px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-content': {
      padding: '16px 0',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 16px 0 8px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'rgba(124, 156, 255, 0.25)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--faint)',
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(124, 156, 255, 0.2)',
      outline: '1px solid rgba(124, 156, 255, 0.4)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(240, 198, 116, 0.25)',
      outline: '1px solid rgba(240, 198, 116, 0.5)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      borderTop: '1px solid var(--border)',
    },
    '.cm-panels input, .cm-panels button': { fontFamily: 'inherit' },
    '.cm-placeholder': { color: 'var(--faint)' },
    // Remote cursors (y-codemirror.next). The name tag is always visible
    // rather than hover-only, so you can tell at a glance who is where.
    '.cm-ySelectionCaret': { borderLeftWidth: '2px', borderRightWidth: '0', marginRight: '-1px' },
    '.cm-ySelectionCaretDot': { display: 'none' },
    '.cm-ySelectionInfo': {
      top: '-1.35em',
      left: '-2px',
      padding: '0 5px',
      borderRadius: '4px 4px 4px 0',
      color: 'var(--accent-text)',
      fontFamily: 'var(--font-sans)',
      fontSize: '11px',
      fontWeight: '600',
      lineHeight: '1.5',
      opacity: '1',
      pointerEvents: 'none',
    },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#c792ea' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#a5d6a7' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#f0a875' },
  { tag: [t.comment, t.meta], color: '#6b7186', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#e6e8ee' },
  { tag: [t.typeName, t.className, t.namespace], color: '#f0c674' },
  { tag: [t.propertyName, t.attributeName], color: '#89ddff' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#a9b1c6' },
  { tag: t.self, color: '#f07178' },
  { tag: t.invalid, color: '#ff5370' },
])

export const editorTheme: Extension = [theme, syntaxHighlighting(highlight)]
