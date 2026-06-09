/**
 * Small text differ for the history view: line-level Myers diff with a
 * word-level refinement pass inside changed regions. Pure JS, no deps —
 * @sanity/diff-match-patch lives in core/sync and is not re-exported, and a
 * word-level rendering needs token spans anyway.
 */

export interface DiffSpan {
  kind: 'equal' | 'insert' | 'delete'
  text: string
}

/** Cap on Myers edit distance before falling back to whole-block replace. */
const MAX_D = 2000

type Op = { kind: DiffSpan['kind']; tokens: string[] }

/** Myers O(ND) diff over token arrays, with a D cap for degenerate inputs. */
function diffTokens(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix first — typical version diffs are mostly equal.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const prefix = a.slice(0, start)
  const suffix = a.slice(endA)
  const mid = myers(a.slice(start, endA), b.slice(start, endB))
  const ops: Op[] = []
  if (prefix.length > 0) ops.push({ kind: 'equal', tokens: prefix })
  ops.push(...mid)
  if (suffix.length > 0) ops.push({ kind: 'equal', tokens: suffix })
  return mergeOps(ops)
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return [{ kind: 'insert', tokens: b }]
  if (m === 0) return [{ kind: 'delete', tokens: a }]

  const max = Math.min(n + m, MAX_D)
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []

  outer: {
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice())
      for (let k = -d; k <= d; k += 2) {
        if (k < -m || k > n) continue
        let x: number
        if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
          x = v[offset + k + 1]!
        } else {
          x = v[offset + k - 1]! + 1
        }
        let y = x - k
        while (x < n && y < m && a[x] === b[y]) {
          x++
          y++
        }
        v[offset + k] = x
        if (x >= n && y >= m) break outer
      }
    }
    // Distance exceeded the cap: treat the whole region as a replace.
    return [
      { kind: 'delete', tokens: a },
      { kind: 'insert', tokens: b },
    ]
  }

  // Backtrack through the trace to recover the edit script.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = prev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', tokens: [a[x - 1]!] })
      x--
      y--
    }
    if (x === prevX) {
      ops.push({ kind: 'insert', tokens: [b[y - 1]!] })
      y--
    } else {
      ops.push({ kind: 'delete', tokens: [a[x - 1]!] })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'equal', tokens: [a[x - 1]!] })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ kind: 'delete', tokens: [a[x - 1]!] })
    x--
  }
  while (y > 0) {
    ops.push({ kind: 'insert', tokens: [b[y - 1]!] })
    y--
  }
  ops.reverse()
  return mergeOps(ops)
}

function mergeOps(ops: Op[]): Op[] {
  const out: Op[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (last && last.kind === op.kind) last.tokens.push(...op.tokens)
    else out.push({ kind: op.kind, tokens: [...op.tokens] })
  }
  return out
}

/** Split into words + whitespace runs (whitespace kept as its own tokens). */
function words(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0)
}

/** Split into lines, each keeping its trailing newline. */
function lines(text: string): string[] {
  const out = text.split('\n')
  const result: string[] = []
  for (let i = 0; i < out.length; i++) {
    result.push(i < out.length - 1 ? `${out[i]}\n` : out[i]!)
  }
  if (result[result.length - 1] === '') result.pop()
  return result
}

const WORD_REFINE_LIMIT = 4000

/**
 * Word-level diff of two texts: line diff first, then a word-level pass over
 * adjacent delete/insert runs so small in-line edits render precisely.
 */
export function diffText(oldText: string, newText: string): DiffSpan[] {
  const lineOps = diffTokens(lines(oldText), lines(newText))
  const spans: DiffSpan[] = []

  for (let i = 0; i < lineOps.length; i++) {
    const op = lineOps[i]!
    const next = lineOps[i + 1]
    if (op.kind === 'delete' && next?.kind === 'insert') {
      const oldChunk = op.tokens.join('')
      const newChunk = next.tokens.join('')
      const aw = words(oldChunk)
      const bw = words(newChunk)
      if (aw.length + bw.length <= WORD_REFINE_LIMIT) {
        for (const wordOp of diffTokens(aw, bw)) {
          spans.push({ kind: wordOp.kind, text: wordOp.tokens.join('') })
        }
        i++
        continue
      }
    }
    spans.push({ kind: op.kind, text: op.tokens.join('') })
  }

  // Merge adjacent same-kind spans for cleaner rendering.
  const merged: DiffSpan[] = []
  for (const span of spans) {
    if (span.text === '') continue
    const last = merged[merged.length - 1]
    if (last && last.kind === span.kind) last.text += span.text
    else merged.push({ ...span })
  }
  return merged
}

export function diffStats(spans: DiffSpan[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const span of spans) {
    if (span.kind === 'insert') added += span.text.length
    if (span.kind === 'delete') removed += span.text.length
  }
  return { added, removed }
}
