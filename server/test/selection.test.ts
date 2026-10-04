import { describe, expect, it } from 'vitest'
import { widenSelection } from '../src/ai/selection.js'

const CODE = [
  'function divide(a, b) {',
  '  return a / b',
  '}',
  '',
  'class Greeter {',
  '  greet(name) {',
  '    console.log("Hello " + name)',
  '  }',
  '}',
].join('\n')

/** The widened text for a selection given by its text (first occurrence). */
function widen(selected: string, language = 'javascript', code = CODE, maxChars = 8_000): string {
  const from = code.indexOf(selected)
  const range = widenSelection(code, { from, to: from + selected.length }, language, maxChars)
  return code.slice(range.from, range.to)
}

describe('widening a selection to the code it means', () => {
  it('widens a word in a function header to the whole function', () => {
    expect(widen('divide')).toBe('function divide(a, b) {\n  return a / b\n}')
  })

  it('widens a word inside a body to just that statement', () => {
    expect(widen('a / b')).toBe('  return a / b')
  })

  it('widens a method name to the whole method, not the whole class', () => {
    expect(widen('greet')).toBe('  greet(name) {\n    console.log("Hello " + name)\n  }')
  })

  it('works for TypeScript too', () => {
    const code = 'export function area(r: number): number {\n  return Math.PI * r * r\n}\n'
    expect(widen('area', 'typescript', code)).toBe('export function area(r: number): number {\n  return Math.PI * r * r\n}')
  })

  it('snaps a selection across lines to whole lines, without growing further', () => {
    expect(widen('return a / b\n}')).toBe('  return a / b\n}')
    expect(widen('ide(a, b) {\n  ret')).toBe('function divide(a, b) {\n  return a / b')
  })

  it('does not include the next line when the selection ends at its start', () => {
    expect(widen('function divide(a, b) {\n  return a / b\n')).toBe('function divide(a, b) {\n  return a / b')
  })

  it('keeps a selection that is already a whole line', () => {
    expect(widen('  return a / b')).toBe('  return a / b')
    expect(widen('return a / b')).toBe('  return a / b')
  })

  it('uses the whole line for languages it cannot parse', () => {
    const python = 'def divide(a, b):\n    return a / b\n'
    expect(widen('divide', 'python', python)).toBe('def divide(a, b):')
  })

  it('falls back to the line when the statement would be too large', () => {
    expect(widen('divide', 'javascript', CODE, 20)).toBe('function divide(a, b) {')
  })

  it('leaves an empty selection alone', () => {
    expect(widenSelection(CODE, { from: 5, to: 5 }, 'javascript', 8_000)).toEqual({ from: 5, to: 5 })
  })

  it('copes with code that does not parse', () => {
    const broken = 'function half(a {\n  return a / 2\n'
    expect(widen('half', 'javascript', broken)).toContain('function half(a {')
  })
})
