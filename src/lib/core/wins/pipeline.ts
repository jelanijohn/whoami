/**
 * The wins draft pipeline (wins-from-journal spec §2.4) — pure over the
 * {@link Llm} seam, so it's trivially fixture-tested with a canned model.
 *
 * Exactly ONE `complete` call, by design (spec §2.4, §9): collapsing several
 * related entries into one win is the whole point, and that synthesis only works
 * when all the related entries sit in the same call. Unlike the reduce pipeline,
 * wins have no second merge pass to reconcile across chunks, so a chunked win
 * could never span a chunk boundary — chunking would silently degrade exactly
 * the feature being built. The input is mostly metadata (a curated multi-select
 * fits the context window many times over); the only real risk is output
 * truncation, which the raised cap covers.
 */

import type { Entry, Llm } from '../types';
import { buildWinsPrompt } from './prompts';
import { parseWins, filterWinsByEvidence } from './parse';
import type { WinDraft } from './schema';

/**
 * Output cap for the wins call when the caller doesn't set one. One or more
 * wins may be drafted, each citing full 26-char ULIDs in `evidence`, so give the
 * output ample headroom. Wins cite fewer ids per item than a full retrospective,
 * so 8k is generous without going enormous (the Llm seam has no streaming).
 */
export const DEFAULT_WINS_MAX_TOKENS = 8192;

export interface DraftWinsInput {
  /** The selected source entries (may include private). */
  entries: Entry[];
  /** Soft output cap for the LLM call. */
  maxTokens?: number;
}

/**
 * One LLM call → drafted wins, filtered to the input ULID set. May return [].
 *
 * An empty result is NOT an error here (unlike reduce, which writes nothing): it
 * means the model drafted nothing it could ground in the selection; the
 * facade/UI reports that plainly. A *malformed* reply still throws.
 */
export async function draftWins(llm: Llm, input: DraftWinsInput): Promise<WinDraft[]> {
  const { entries } = input;
  if (!entries.length) throw new Error('wins: no entries selected to draft from');

  const maxTokens = input.maxTokens ?? DEFAULT_WINS_MAX_TOKENS;
  const validIds = new Set(entries.map((e) => String(e.frontmatter.id)));
  const raw = await llm.complete({ ...buildWinsPrompt(entries), maxTokens });
  return filterWinsByEvidence(parseWins(raw), validIds);
}
