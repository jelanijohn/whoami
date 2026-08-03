/**
 * The map/reduce pipeline (ingest-reduce plan §4.3) — pure over the {@link Llm}
 * seam, so it's trivially fixture-tested with a canned model.
 *
 * Map: one `complete` per chunk → structured facts, each filtered to the
 * chunk's own ULIDs. Reduce: one `complete` over the concatenated map outputs
 * (plus rollup + project prose) → the merged four lists, filtered to the full
 * input ULID set. A failed chunk fails the whole run (no partial silent
 * results); an empty surviving set fails visibly.
 *
 * Prompts speak short aliases, not ULIDs (see `alias.ts`): one table covers the
 * whole run, and every parsed reply is expanded back to real ids BEFORE the
 * evidence filters — so everything outside the LLM round-trip sees only ULIDs.
 */

import type { Entry, Llm } from '../types';
import { buildAliasTable, expandRetro } from './alias';
import { chunkEntries } from './chunk';
import { buildMapPrompt, buildReducePrompt } from './prompts';
import { parseRetrospective, filterByEvidence } from './parse';
import { factCount, type Retrospective } from './schema';
import { rollupEntries, rollupSummary } from './rollup';

/**
 * Output cap for map/reduce calls when the caller doesn't set one (plan §4.3).
 *
 * Evidence ids are now short aliases (~2 output tokens vs ~15 for a quoted
 * ULID — see `alias.ts`), so overflow is no longer expected even for a large
 * project. 32,000 is retained as a safety net; it is also the output ceiling of
 * the oldest Anthropic models worth supporting (Opus 4.x) — any higher and the
 * API rejects the request outright instead of truncating.
 */
export const DEFAULT_REDUCE_MAX_TOKENS = 32_000;

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
  // One alias table covers the whole run, so map and reduce prompts agree on
  // what "E47" means and merged evidence unions stay coherent.
  const table = buildAliasTable(entries.map((e) => String(e.frontmatter.id)));
  const validIds = new Set(entries.map((e) => String(e.frontmatter.id)));
  const mapOutputs: Retrospective[] = [];
  for (const chunk of chunks) {
    const chunkIds = new Set(chunk.map((e) => String(e.frontmatter.id)));
    const raw = await llm.complete({ ...buildMapPrompt(chunk, table), maxTokens });
    // Expand aliases back to ULIDs, then: map facts may only cite ids from
    // their own chunk (plan §4.3).
    mapOutputs.push(filterByEvidence(expandRetro(parseRetrospective(raw), table), chunkIds));
  }

  // An empty surviving fact set fails visibly rather than writing nothing.
  const requireFacts = (retro: Retrospective): Retrospective => {
    if (factCount(retro) === 0) {
      throw new Error('reduce: produced no verifiable facts (nothing written)');
    }
    return retro;
  };

  // Single chunk: the map output already IS the answer — the reduce pass only
  // merges/orders facts ACROSS chunks, of which there are none here, so skip the
  // extra LLM call (TODO §3.5). The full-set evidence filter still runs (it's the
  // same id set the chunk was filtered by, so it's a safe no-op) and the
  // empty-result guard still holds. Tradeoff: the reduce pass's chronological
  // re-ordering and rollup/prose context aren't applied to a lone chunk —
  // acceptable, since there is nothing to merge.
  if (chunks.length === 1) {
    return requireFacts(filterByEvidence(mapOutputs[0], validIds));
  }

  const summary = rollupSummary(rollupEntries(entries));
  const raw = await llm.complete({
    ...buildReducePrompt(mapOutputs, summary, input.projectProse, table),
    maxTokens
  });
  return requireFacts(filterByEvidence(expandRetro(parseRetrospective(raw), table), validIds));
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
