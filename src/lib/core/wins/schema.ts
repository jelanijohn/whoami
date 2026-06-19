/**
 * The closed schema the LLM is constrained to when drafting wins
 * (wins-from-journal spec §2.1).
 *
 * A {@link WinDraft} cites the entry ULIDs it was derived from; the pipeline
 * DROPS any draft whose evidence is empty or references a ULID outside the
 * selected set, so an ungrounded claim cannot survive by construction — the same
 * evidence discipline as `reduce/`.
 */

export interface WinDraft {
  /** The accomplishment statement, reframed as outcome/impact. */
  text: string;
  /** Source entry ULIDs this win was derived from (>=1 after filtering). */
  evidence: string[];
}

export interface WinsPayload {
  wins: WinDraft[];
}

/** An empty payload (no drafts). */
export function emptyWins(): WinsPayload {
  return { wins: [] };
}
