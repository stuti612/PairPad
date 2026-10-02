import { EditorState, type Extension, type Text } from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'

/**
 * The server refuses documents over 1 MB, measured with the CRDT's own
 * bookkeeping included, and a refused edit cannot be taken back out of the
 * local copy. So the editor stops accepting new text a little earlier,
 * leaving room for that bookkeeping.
 */
export const MAX_TEXT_BYTES = 900_000

function utf8Length(doc: Text): number {
  let bytes = 0
  for (const chunk of doc.iter()) {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      // Each half of a surrogate pair counts 2, for the pair's 4 bytes.
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 2
      else bytes += 3
    }
  }
  return bytes
}

/** Blocks your own edits that would grow the text past the limit. Deleting always works. */
export function sizeLimit(onBlocked: () => void): Extension {
  return EditorState.transactionFilter.of((tr) => {
    // Other people's changes arrive already accepted by the server.
    if (!tr.docChanged || tr.annotation(ySyncAnnotation)) return tr
    const length = tr.newDoc.length
    if (length <= tr.startState.doc.length) return tr
    // A character is at most 3 bytes in UTF-8 per UTF-16 unit, so small
    // documents are waved through without counting.
    if (length * 3 <= MAX_TEXT_BYTES) return tr
    if (utf8Length(tr.newDoc) <= MAX_TEXT_BYTES) return tr
    queueMicrotask(onBlocked)
    return []
  })
}
