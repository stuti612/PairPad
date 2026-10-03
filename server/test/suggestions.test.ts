import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SuggestionStore, type Suggestion } from '../src/ai/suggestions.js'

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

describe('suggestion store', () => {
  it('anchors the range to the code, not to positions', () => {
    const doc = docWith('alpha beta gamma')
    const store = new SuggestionStore(doc)
    const suggestion = store.create({ author: 'A', instruction: 'i', language: 'javascript', from: 6, to: 10 })
    expect(suggestion.originalText).toBe('beta')

    const text = doc.getText('content')
    text.insert(0, '>> ') // before the range
    text.insert(text.length, ' <<') // after it
    text.insert(13, '!') // right after "beta": outside the range
    text.insert(9, '[') // right before "beta": outside the range
    const range = store.locate(store.get(suggestion.id)!)!
    expect(text.toString().slice(range.from, range.to)).toBe('beta')
    expect(store.isCurrent(store.get(suggestion.id)!)).toBe(true)

    text.insert(range.from + 2, 'X') // inside it
    expect(store.isCurrent(store.get(suggestion.id)!)).toBe(false)
  })

  it('notices when the code under a suggestion is deleted', () => {
    const doc = docWith('keep remove keep')
    const store = new SuggestionStore(doc)
    const suggestion = store.create({ author: 'A', instruction: 'i', language: 'javascript', from: 5, to: 11 })
    doc.getText('content').delete(5, 7)
    expect(store.isCurrent(store.get(suggestion.id)!)).toBe(false)
  })

  it('marks requests left running by a restart as failed when the pad loads again', () => {
    const doc = docWith('code')
    const first = new SuggestionStore(doc)
    const suggestion = first.create({ author: 'A', instruction: 'i', language: 'javascript', from: 0, to: 4 })
    first.destroy()

    const reloaded = new Y.Doc()
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc))
    const store = new SuggestionStore(reloaded)
    expect(store.get(suggestion.id)).toMatchObject({ status: 'failed', phase: null })
    expect(store.get(suggestion.id)!.failureReasons[0]).toMatch(/restarted/)
    expect(reloaded.getMap<Suggestion>('suggestions').get(suggestion.id)!.status).toBe('failed')
  })

  it('keeps only the 30 most recent decided suggestions', () => {
    let now = 1_000
    const doc = docWith('code')
    const store = new SuggestionStore(doc, () => now++)
    const ids: string[] = []
    for (let i = 0; i < 35; i++) {
      const suggestion = store.create({ author: 'A', instruction: `${i}`, language: 'javascript', from: 0, to: 4 })
      store.update(suggestion.id, { status: 'pending', proposedText: 'x' })
      store.reject(suggestion.id, 'A')
      ids.push(suggestion.id)
    }
    const pending = store.create({ author: 'A', instruction: 'open', language: 'javascript', from: 0, to: 4 })
    expect(store.all()).toHaveLength(31)
    expect(store.get(ids[0]!)).toBeUndefined()
    expect(store.get(ids[34]!)).toBeDefined()
    expect(store.get(pending.id)).toBeDefined()
    expect(doc.getMap('suggestions').size).toBe(31)
  })
})
