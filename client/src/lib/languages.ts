import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'

export const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'plaintext', label: 'Plain text' },
] as const

export type LanguageId = (typeof LANGUAGES)[number]['id']

export const DEFAULT_LANGUAGE: LanguageId = 'javascript'

export function isLanguageId(value: unknown): value is LanguageId {
  return LANGUAGES.some((language) => language.id === value)
}

export function languageExtension(id: LanguageId): Extension {
  switch (id) {
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true })
    case 'python':
      return python()
    case 'plaintext':
      return []
  }
}
