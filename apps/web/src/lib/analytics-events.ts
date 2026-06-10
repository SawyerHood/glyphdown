/**
 * THE event-name registry — every intentional product event, client AND
 * server, is declared here (autocapture is off; nothing else ever fires).
 * Adding an event means adding it to this map; `track()` /
 * `captureServerEvent()` are typed against it, so a typo'd name or a missing
 * property is a compile error, not a silent analytics gap.
 *
 * PRIVACY CONTRACT: no document content, no comment/suggestion bodies, no
 * search query text, no email addresses in event properties. Doc ids are fine
 * (internal product analytics).
 */

export interface AnalyticsEvents {
  /** First session for this user on this browser (fires on the anonymous→identified transition). */
  sign_in: Record<string, never>
  /** A document was created (file tree / browser, or a wiki-link create-on-open). */
  doc_created: { docId: string; source: 'file-tree' | 'wiki-link' }
  folder_created: Record<string, never>
  /** A vault was created from the header switcher. */
  vault_created: Record<string, never>
  /** A vault (and its whole subtree, to trash) was deleted. */
  vault_deleted: Record<string, never>
  /** The editor finished its first Yjs sync for a doc — the doc is truly open. */
  doc_opened: { docId: string; role: string }
  /** A share link was created (member adds ride invite_sent instead). */
  doc_shared: { docId: string; role: string; via: 'share-link' }
  /** A vault share link was created (copies the /f/:folderId landing URL). */
  vault_shared: { role: string; via: 'share-link' }
  /** Email invite created. status 'added' = recipient already had an account. */
  invite_sent: { targetType: 'doc' | 'folder'; role: string; status: 'added' | 'invited' }
  invite_accepted: { targetType: 'doc' | 'folder'; role: string }
  /** A new suggestion record came out of suggest mode (deduped per record id). */
  suggestion_created: { docId: string }
  suggestion_accepted: { docId: string }
  /** withdrawn=true when the author retracted their own suggestion. */
  suggestion_rejected: { docId: string; withdrawn: boolean }
  comment_created: { docId: string; kind: 'anchored' | 'doc-level' | 'reply' }
  version_named: { docId: string }
  /** Full-text search executed. Result count ONLY — never the query text. */
  search_performed: { resultCount: number }
  /** SERVER-side: a successful POST /api/docs/:id/push (CLI / agents). */
  cli_push: { docId: string; mode: 'edit' | 'suggest'; principalType: 'user' | 'agent' }
}

export type AnalyticsEventName = keyof AnalyticsEvents

/** Runtime mirror of the registry keys (tests assert centralization against it). */
export const ANALYTICS_EVENT_NAMES = [
  'sign_in',
  'doc_created',
  'folder_created',
  'vault_created',
  'vault_deleted',
  'doc_opened',
  'doc_shared',
  'vault_shared',
  'invite_sent',
  'invite_accepted',
  'suggestion_created',
  'suggestion_accepted',
  'suggestion_rejected',
  'comment_created',
  'version_named',
  'search_performed',
  'cli_push',
] as const satisfies ReadonlyArray<AnalyticsEventName>
