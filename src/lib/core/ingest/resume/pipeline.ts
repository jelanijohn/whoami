/**
 * The résumé extraction pass (spec §4, §6) — text → `RawItem[]`.
 *
 * THE BOUNDARY (spec §0 rule 1): this runs in the import-action layer, BEFORE
 * `stageItems`. It is the one LLM call near entry formation, and it only
 * *structures* a pre-curated document — it never writes a candidate and never
 * decides what is staged beyond proposing the items (spec §0.1). `pipeline.ts`/
 * `stageItems` stay deterministic and LLM-free.
 *
 * Chunk → one `llm.complete` per chunk → `parseResumeItems` → concat → dedupe by
 * `sourceId`. A failed or garbled chunk is reported in `errors`, never thrown,
 * so one bad chunk never loses the rest of the résumé.
 */

import type { Llm } from '../../types';
import type { RawItem } from '../types';
import { buildResumePrompt } from './prompts';
import { chunkResumeText } from './chunk';
import { parseResumeItems } from './parse';

export interface ParseResumeOpts {
  /** Soft token budget per extraction call (default {@link RESUME_TOKEN_BUDGET}). */
  tokenBudget?: number;
  /** `provider:model` label, advisory — the `Llm` client already carries its
   * own model; kept for parity with the triage call site (spec §6). */
  model?: string;
}

export interface ParseResumeResult {
  items: RawItem[];
  /** Per-item drops (undated / unverifiable) and per-chunk failures — surfaced
   * to the owner so they know what was skipped and can add it by hand (spec §6). */
  errors: string[];
}

/** Run the extraction over `text`, returning the proposed items plus a report
 * of everything dropped. Never throws on a bad chunk. */
export async function parseResume(
  llm: Llm,
  text: string,
  opts: ParseResumeOpts = {}
): Promise<ParseResumeResult> {
  const chunks = chunkResumeText(text, { tokenBudget: opts.tokenBudget });
  const errors: string[] = [];
  const items: RawItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    let parsed: RawItem[] = [];
    try {
      const raw = await llm.complete(buildResumePrompt(chunks[i]));
      // Validate excerpts against the FULL résumé, not just this chunk, so a
      // span that reflowed across a chunk boundary still verifies.
      parsed = parseResumeItems(raw, text, errors);
    } catch (e) {
      errors.push(`chunk ${i + 1}/${chunks.length} failed: ${String(e)}`);
      continue;
    }
    for (const item of parsed) {
      if (seen.has(item.sourceId)) continue; // dedupe across chunks
      seen.add(item.sourceId);
      items.push(item);
    }
  }
  return { items, errors };
}
