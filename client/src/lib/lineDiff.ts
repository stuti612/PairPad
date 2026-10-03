export type DiffOp = { type: 'same' | 'removed' | 'added'; line: string }

/**
 * Line-by-line diff (longest common subsequence). Suggestions cover at most
 * a few hundred lines, so the quadratic table is fine.
 */
export function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length
  const m = after.length
  // lengths[i][j] = LCS length of before[i..] and after[j..]
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'same', line: before[i]! })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      ops.push({ type: 'removed', line: before[i++]! })
    } else {
      ops.push({ type: 'added', line: after[j++]! })
    }
  }
  while (i < n) ops.push({ type: 'removed', line: before[i++]! })
  while (j < m) ops.push({ type: 'added', line: after[j++]! })
  return ops
}

/** Splits text into lines; an empty text has no lines at all. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}
