import { type LlmClient, type StructuredRequest } from './llm.js'

const DELAY_MS = 700

/**
 * A stand-in "model" for end-to-end tests and demos without an API key
 * (AI_PROVIDER=mock). It is not AI: it adds a comment naming the instruction
 * above the target region, and gives every suggestion a passing score.
 * An instruction containing "[low score]" gets failing scores instead, so the
 * failure path can be exercised too.
 *
 * An instruction containing "[bad syntax]" gets code that doesn't parse on
 * the first attempt and valid code on the retry, to show the gate at work.
 *
 * It reads the prompts built in prompts.ts (and the judge's), so it changes
 * along with them.
 */
export class MockLlm implements LlmClient {
  readonly label = 'Mock AI'

  async complete<T>(request: StructuredRequest<T>): Promise<T> {
    await delay(DELAY_MS, request.signal)
    const instruction = /^Instruction: (.*)$/m.exec(request.prompt)?.[1] ?? 'change'

    if (request.role === 'generate') {
      const language = /^Language: (.*)$/m.exec(request.prompt)?.[1] ?? ''
      const region = /<target_region>\n([\s\S]*?)\n<\/target_region>/.exec(request.prompt)?.[1] ?? ''
      const target = region.startsWith('(empty') ? '' : region
      const indent = /^[ \t]*/.exec(target)?.[0] ?? ''
      const marker = language === 'Python' ? '#' : '//'
      const label = instruction.replace(/\[(low score|bad syntax)\]/g, '').trim()
      const comment = `${indent}${marker} PairPad AI: ${label}`
      const retrying = request.prompt.includes('A previous attempt')
      const broken = instruction.includes('[bad syntax]') && !retrying ? '\n{' : ''
      return request.schema.parse({
        replacement: (target === '' ? comment : `${comment}\n${target}`) + broken,
        summary: `Added a note about "${instruction}".`,
      })
    }

    const low = instruction.includes('[low score]')
    const score = low ? 0.3 : 0.9
    return request.schema.parse({
      does_what_was_asked: { score, reason: low ? 'Only adds a comment.' : 'Matches the request.' },
      minimal_and_in_scope: { score, reason: 'Touches only the selected code.' },
      safe: { score: low ? 0.5 : 0.95, reason: 'No risky operations.' },
    })
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    })
  })
}
