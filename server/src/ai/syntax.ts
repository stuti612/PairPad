import ts from 'typescript'

export interface SyntaxResult {
  status: 'passed' | 'failed' | 'skipped'
  message: string
}

const FILE_NAMES: Record<string, string> = {
  javascript: 'pad.js',
  typescript: 'pad.ts',
}

/**
 * Checks that a suggestion leaves the pad parseable, using the TypeScript
 * compiler's parser (syntax only: no type checking, no imports resolved).
 *
 * Scratch code is often unfinished, so the rule is relative: a suggestion
 * fails only if the pad has more syntax errors after it than before. A pad
 * that parsed must still parse.
 */
export function checkSyntax(language: string, before: string, after: string): SyntaxResult {
  const fileName = FILE_NAMES[language]
  if (!fileName) {
    return { status: 'skipped', message: `No syntax check for ${language === 'plaintext' ? 'plain text' : language}.` }
  }
  const errorsBefore = syntaxErrors(fileName, before)
  const errorsAfter = syntaxErrors(fileName, after)
  if (errorsAfter.length <= errorsBefore.length) {
    return {
      status: 'passed',
      message: errorsBefore.length === 0 ? 'The code still parses.' : 'Adds no new syntax errors.',
    }
  }
  // Report an error the suggestion introduced, not one that was already there.
  const known = new Set(errorsBefore.map((error) => error.text))
  const introduced = errorsAfter.find((error) => !known.has(error.text)) ?? errorsAfter[0]!
  return { status: 'failed', message: `The result doesn't parse: ${introduced.where}${introduced.text}` }
}

interface SyntaxError {
  where: string
  text: string
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  'pad.js': ts.ScriptKind.JS,
  'pad.ts': ts.ScriptKind.TS,
}

function syntaxErrors(fileName: string, source: string): SyntaxError[] {
  return diagnosticsOf(fileName, source)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      if (diagnostic.file && diagnostic.start !== undefined) {
        const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        return { where: `line ${line + 1}: `, text }
      }
      return { where: '', text }
    })
}

// Below this size the full check runs; above it, a parse-only check.
const FULL_CHECK_MAX_CHARS = 200_000

/**
 * The full check (the compiler's syntactic diagnostics) also catches
 * TypeScript-only syntax, such as type annotations, in a JavaScript pad.
 * It costs about 0.6 ms per kB, and this runs on the server's only thread,
 * so for very large pads a parse-only check is used instead: about ten
 * times faster, but it misses that TypeScript-in-JavaScript case. The
 * parser's diagnostics are an internal field; if a future TypeScript
 * version removes it, the full check is used regardless of size.
 */
function diagnosticsOf(fileName: string, source: string): readonly ts.Diagnostic[] {
  if (source.length > FULL_CHECK_MAX_CHARS) {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, SCRIPT_KINDS[fileName])
    const parsed = (file as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics
    if (Array.isArray(parsed)) return parsed
  }
  return (
    ts.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, allowJs: true, noEmit: true },
    }).diagnostics ?? []
  )
}
