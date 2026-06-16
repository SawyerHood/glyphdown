export { FUZZY_ACCEPT_THRESHOLD, QUOTE_CONTEXT, REANCHOR_THRESHOLD, captureQuote, findQuote, similarity } from './quote.ts'
export type { QuoteMatch, TextQuote } from './quote.ts'
export { createAnchor, decodeRelPos, encodeRelPos, resolveAnchor, validateOrReanchor } from './anchor.ts'
export type { Anchor, Range } from './anchor.ts'
export { DEGENERATE_DELETE_RATIO, applyDiffsToYText, computeMergedTarget, mergePush, normalizeEol } from './merge.ts'
export type { MergeComputation, MergeOptions, PushResult } from './merge.ts'
export { acceptSuggestion, cleanText, materializeSuggestion, rejectSuggestion } from './suggestions.ts'
export type { MaterializeInput, Suggestion, SuggestionPart, SuggestionStatus } from './suggestions.ts'
export { restoreText } from './snapshot.ts'
export { COALESCE_MAX_PARAGRAPH_GAP, COALESCE_WINDOW_MS, SuggestSession } from './suggest-session.ts'
export type { SuggestSessionOptions } from './suggest-session.ts'
export {
  NODE_AMBIGUITY_MARGIN,
  NODE_FUZZY_ACCEPT,
  NODE_MIN_TEXT_CHARS,
  NODE_SCORE_WEIGHTS,
  NODE_VALIDATE,
  NODE_WEAK_QUOTE_GUARD,
  createNodeAnchor,
  nodeAnchorMinimumOk,
  nodeAnchorsEqual,
  normalizeClassList,
  normalizeClassToken,
  normalizeHtmlText,
  parseHtmlNodeIndex,
  resolveNodeAnchor,
  scoreNodeCandidate,
} from './node-anchor.ts'
export type {
  HtmlIndexedNode,
  HtmlNodeIndex,
  NodeAnchor,
  NodeAnchorResolution,
  NodeAnchorScore,
  NodeAnchorTarget,
  NodeFingerprint,
  NodeStep,
} from './node-anchor.ts'
