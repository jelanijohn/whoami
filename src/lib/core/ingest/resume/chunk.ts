/**
 * Chunk a long CV into pieces under the model's token budget (spec §4).
 *
 * A typical 1–2 page résumé fits a single chunk; only a long multi-page CV
 * splits. Splits fall on section / blank-line boundaries, packing paragraphs
 * under the budget, reusing `estimateTokens` from `reduce/chunk.ts`. Pure and
 * deterministic.
 */

import { estimateTokens } from '../../reduce/chunk';

/** ~8k tokens of résumé text per extraction call (mirrors reduce's budget). */
export const RESUME_TOKEN_BUDGET = 8_000;

/**
 * Split `text` into chunks whose estimated size stays under `tokenBudget`,
 * breaking only on blank-line boundaries so a role's lines stay together. A
 * single block larger than the whole budget still gets its own chunk rather
 * than being dropped (mirrors `chunkEntries`).
 */
export function chunkResumeText(text: string, opts: { tokenBudget?: number } = {}): string[] {
  const budget = opts.tokenBudget ?? RESUME_TOKEN_BUDGET;
  if (!text.trim()) return [];
  if (estimateTokens(text) <= budget) return [text];

  const blocks = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  let tokens = 0;
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    const t = estimateTokens(b);
    if (current && tokens + t > budget) {
      chunks.push(current);
      current = '';
      tokens = 0;
    }
    current = current ? `${current}\n\n${b}` : b;
    tokens += t;
  }
  if (current) chunks.push(current);
  return chunks;
}
