import ts from 'typescript'

export interface Range {
  from: number
  to: number
}

/**
 * Turns what someone selected into the code the AI should rewrite.
 *
 * People rarely select exactly the code they mean: they double-click a
 * function's name and ask to "add validation to this function". Rewriting
 * just the name cannot work, so:
 *
 * - A selection inside a single line is widened to the statement around it.
 *   For JavaScript and TypeScript that is the innermost declaration or
 *   statement containing it (the whole function, for a word in its header);
 *   for other languages, the whole line.
 * - Any other selection is widened to whole lines, so a suggestion never
 *   starts or ends in the middle of a line.
 *
 * An empty selection is returned as is; the caller treats it as "the whole pad".
 * If widening would exceed `maxChars`, only whole lines are used.
 */
export function widenSelection(content: string, range: Range, language: string, maxChars: number): Range {
  const { from, to } = range
  if (from === to) return range

  // A selection that ends at the start of a line (after selecting whole
  // lines with Shift+Down) does not include that next line.
  const lastChar = content[to - 1] === '\n' ? to - 1 : to
  const lineStart = content.lastIndexOf('\n', from - 1) + 1
  const nextBreak = content.indexOf('\n', lastChar)
  const lineEnd = nextBreak === -1 ? content.length : nextBreak
  const lines = { from: lineStart, to: lineEnd }

  const withinOneLine = !content.slice(from, lastChar).includes('\n')
  const coversLine = content.slice(lineStart, lineEnd).trim() === content.slice(from, lastChar).trim()
  if (!withinOneLine || coversLine) return lines

  if (language === 'javascript' || language === 'typescript') {
    const statement = enclosingStatement(content, from, lastChar, language)
    if (statement && statement.to - statement.from <= maxChars) {
      return widenToLines(content, statement)
    }
  }
  return lines
}

function widenToLines(content: string, { from, to }: Range): Range {
  const start = content.lastIndexOf('\n', from - 1) + 1
  const end = content.indexOf('\n', to)
  return { from: start, to: end === -1 ? content.length : end }
}

/**
 * The innermost node that sits directly in a list of statements (the file,
 * a block, a class body, a switch case) and contains the whole range.
 */
function enclosingStatement(content: string, from: number, to: number, language: string): Range | null {
  const file = ts.createSourceFile(
    language === 'typescript' ? 'pad.ts' : 'pad.js',
    content,
    ts.ScriptTarget.Latest,
    true,
    language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  let best: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    const start = node.getStart(file)
    if (start > from || node.end < to) return
    if (isListedStatement(node)) best = node
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  const found = best as ts.Node | null
  return found ? { from: found.getStart(file), to: found.end } : null
}

function isListedStatement(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  return (
    ts.isSourceFile(parent) ||
    ts.isBlock(parent) ||
    ts.isModuleBlock(parent) ||
    ts.isCaseClause(parent) ||
    ts.isDefaultClause(parent) ||
    (ts.isClassLike(parent) && ts.isClassElement(node))
  )
}
