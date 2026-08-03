/**
 * Chunking the chronologically-ordered entries into windows under a token
 * budget (ingest-reduce plan §4.3). A real project's entries won't fit one
 * context window, so the map phase runs over chunks.
 *
 * Pure and deterministic. Token estimate ≈ chars / 4 (the standard rough rule).
 */

import type { Entry } from '../types';

/** Conservative default: ~8k tokens of entry data per map call. */
export const DEFAULT_TOKEN_BUDGET = 8_000;

/** Rough token estimate for a string (≈ chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Serialize one entry into the fenced-block shape the map prompt embeds.
 * Prompts pass a short `displayId` alias (see `alias.ts`); the chunker measures
 * the real-ULID form, so budgeting slightly OVERestimates the aliased prompt —
 * conservative by construction. */
export function serializeEntryBlock(entry: Entry, displayId?: string): string {
  const fm = entry.frontmatter;
  const body = entry.body.trim();
  return [
    `id: ${displayId ?? fm.id}`,
    `date: ${fm.date}`,
    `type: ${fm.type}`,
    `title: ${fm.title}`,
    body ? `body: ${body}` : 'body:'
  ].join('\n');
}

/**
 * Group entries into chunks whose serialized size stays under `tokenBudget`.
 * Order is preserved (caller sorts chronologically first). An entry larger than
 * the whole budget still gets its own chunk rather than being dropped.
 */
export function chunkEntries(
  entries: Entry[],
  opts: { tokenBudget?: number } = {}
): Entry[][] {
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const chunks: Entry[][] = [];
  let current: Entry[] = [];
  let currentTokens = 0;

  for (const entry of entries) {
    const tokens = estimateTokens(serializeEntryBlock(entry));
    if (current.length > 0 && currentTokens + tokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(entry);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
