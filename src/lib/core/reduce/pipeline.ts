/**
 * The map/reduce pipeline (ingest-reduce plan §4.3) — pure over the {@link Llm}
 * seam, so it's trivially fixture-tested with a canned model.
 *
 * Map: one `complete` per chunk → structured facts, each filtered to the
 * chunk's own ULIDs. Reduce: one `complete` over the concatenated map outputs
 * (plus rollup + project prose) → the merged four lists, filtered to the full
 * input ULID set. A failed chunk fails the whole run (no partial silent
 * results); an empty surviving set fails visibly.
 */

import type { Entry, Llm } from '../types';
import { chunkEntries } from './chunk';
import { buildMapPrompt, buildReducePrompt } from './prompts';
import { parseRetrospective, filterByEvidence } from './parse';
import { factCount, type Retrospective } from './schema';
import { rollupEntries, rollupSummary } from './rollup';

/**
 * Output cap for map/reduce calls when the caller doesn't set one (plan §4.3).
 *
 * The merged retrospective for a real project is many facts, each citing full
 * 26-char ULIDs in `evidence`, so its JSON easily overflows the provider's tiny
 * 4096-token default — the reply truncates mid-object and the strict parse
 * fails with "model reply was not valid JSON". 16k gives ample headroom without
 * going enormous (the Llm seam has no streaming).
 */
export const DEFAULT_REDUCE_MAX_TOKENS = 16_384;

export interface ReducePipelineInput {
  /** Entries to summarize — caller sorts chronologically; may include private. */
  entries: Entry[];
  /** The human's project prose (project body with the reduce region stripped). */
  projectProse: string;
  /** Per-chunk data budget; see {@link chunkEntries}. */
  tokenBudget?: number;
  /** Soft output cap per LLM call. */
  maxTokens?: number;
}

/** Run map then reduce, returning the merged, evidence-verified retrospective. */
export async function runReducePipeline(
  llm: Llm,
  input: ReducePipelineInput
): Promise<Retrospective> {
  const { entries } = input;
  if (!entries.length) throw new Error('reduce: project has no entries to summarize');

  const maxTokens = input.maxTokens ?? DEFAULT_REDUCE_MAX_TOKENS;
  const chunks = chunkEntries(entries, { tokenBudget: input.tokenBudget });
  const mapOutputs: Retrospective[] = [];
  for (const chunk of chunks) {
    const chunkIds = new Set(chunk.map((e) => String(e.frontmatter.id)));
    const raw = await llm.complete({ ...buildMapPrompt(chunk), maxTokens });
    // Map facts may only cite ids from their own chunk (plan §4.3).
    mapOutputs.push(filterByEvidence(parseRetrospective(raw), chunkIds));
  }

  const validIds = new Set(entries.map((e) => String(e.frontmatter.id)));
  const summary = rollupSummary(rollupEntries(entries));
  const raw = await llm.complete({
    ...buildReducePrompt(mapOutputs, summary, input.projectProse),
    maxTokens
  });
  const merged = filterByEvidence(parseRetrospective(raw), validIds);

  if (factCount(merged) === 0) {
    throw new Error('reduce: produced no verifiable facts (nothing written)');
  }
  return merged;
}

/** A reduce proposal awaiting the human's accept gate (plan §4.4). Nothing is
 * written until {@link RecordStore.saveProjectReduction} is called. */
export interface ReduceProposal {
  slug: string;
  projectEntryId: string;
  entryCount: number;
  retro: Retrospective;
  /** Rendered inner block (no markers) — what Save upserts. */
  inner: string;
  /** Existing region inner, for the diff preview ('' if none yet). */
  currentInner: string;
  /** Current full project body. */
  currentBody: string;
  /** Project body with the region upserted — the exact bytes Save writes. */
  proposedBody: string;
}
