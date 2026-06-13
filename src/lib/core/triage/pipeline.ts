/**
 * The triage pass (triage spec §3, §5) — prefilter first, optional LLM second.
 *
 * THE BOUNDARY (spec §0 rule 2): this lives in the import-action layer, NOT in
 * `ingest/pipeline.ts`. The model never decides *what gets staged* — every
 * fetched item is still staged; triage only annotates the sort signal. Runs the
 * deterministic prefilter over every item; routes only the prefilter-`unsure`
 * remainder to the LLM, and only when `opts.llm` is provided. With `llm`
 * null/absent it is prefilter-only and never touches the network (spec §3, §5).
 *
 * FAIL-OPEN: any item the LLM does not score stays `keep` (spec §4 rule 4). A
 * failed chunk fails that chunk's items open to `keep`, never aborting the run.
 */

import { nowIso } from '../entry';
import { provenanceKey } from '../record';
import { estimateTokens } from '../reduce/chunk';
import type { Llm } from '../types';
import type { RawItem } from '../ingest/types';
import { prefilterItem } from './prefilter';
import { buildTriagePrompt, triageItemView } from './prompts';
import { parseVerdicts } from './parse';
import { DEFAULT_RUBRIC, type TriageRubric, type TriageResult } from './types';

export interface TriageOpts {
  rubric?: TriageRubric;
  /** When provided AND the unsure set is non-empty, the ambiguous remainder is
   * sent to this client. Null/absent ⇒ prefilter-only, no network. */
  llm?: Llm | null;
  /** `provider:model` label persisted on LLM-sourced signals. */
  model?: string;
  /** Soft cap on items per LLM call (default 40, spec §5). */
  maxItemsPerCall?: number;
}

/** ~8k tokens of item data per LLM call (mirrors reduce's budget). */
const TRIAGE_TOKEN_BUDGET = 8_000;
const DEFAULT_MAX_ITEMS_PER_CALL = 40;

/** Group items into chunks bounded by both a count and a rough token estimate
 * (spec §5 chunking). Uses the exact serialized view the prompt embeds. */
function chunkItems(items: RawItem[], maxItems: number): RawItem[][] {
  const chunks: RawItem[][] = [];
  let current: RawItem[] = [];
  let tokens = 0;
  for (const item of items) {
    const t = estimateTokens(JSON.stringify(triageItemView(item)));
    if (current.length > 0 && (current.length >= maxItems || tokens + t > TRIAGE_TOKEN_BUDGET)) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += t;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The LLM pass (spec §5): send EVERY given item to the model — no prefilter
 * gating — chunked, folding each verdict into a `provenanceKey → TriageResult`
 * entry. FAIL-OPEN: a failed chunk or an unscored id stays `keep`; only an
 * explicit model `keep:false` flips an item to `frivolous`.
 */
async function runLlmPass(
  items: RawItem[],
  llm: Llm,
  rubric: TriageRubric,
  model: string | undefined,
  maxItems: number,
  at: string
): Promise<Map<string, TriageResult>> {
  const results = new Map<string, TriageResult>();
  for (const chunk of chunkItems(items, maxItems)) {
    const validIds = new Set(chunk.map((i) => provenanceKey(String(i.source), i.sourceId)));
    let verdicts: ReturnType<typeof parseVerdicts> = new Map();
    try {
      const raw = await llm.complete(buildTriagePrompt(chunk, rubric));
      verdicts = parseVerdicts(raw, validIds);
    } catch {
      // A failed chunk (transport or parse) fails its items open to keep.
      verdicts = new Map();
    }
    for (const item of chunk) {
      const key = provenanceKey(String(item.source), item.sourceId);
      const v = verdicts.get(key);
      if (!v) {
        // Unscored id → fail-open keep (never flip to frivolous).
        results.set(key, { signal: 'keep', reason: 'unscored', source: 'llm', model, at });
      } else if (v.keep) {
        results.set(key, { signal: 'keep', reason: v.reason || 'kept by model', source: 'llm', model, at });
      } else {
        results.set(key, {
          signal: 'frivolous',
          reason: v.reason || 'flagged by model',
          source: 'llm',
          model,
          at
        });
      }
    }
  }
  return results;
}

/**
 * Triage a batch of items, returning a map keyed by `provenanceKey`. Every input
 * item gets exactly one result (the inbox sorts by it; absence would mean
 * "untriaged" = keep, but we annotate explicitly so re-imports are stable).
 */
export async function triageItems(
  items: RawItem[],
  opts: TriageOpts = {}
): Promise<Map<string, TriageResult>> {
  const rubric = opts.rubric ?? DEFAULT_RUBRIC;
  const at = nowIso();
  const results = new Map<string, TriageResult>();
  const unsure: RawItem[] = [];

  // Pass 1 — the always-on deterministic floor.
  for (const item of items) {
    const key = provenanceKey(String(item.source), item.sourceId);
    const { verdict, reason } = prefilterItem(item, rubric);
    if (verdict === 'unsure') {
      unsure.push(item);
    } else {
      results.set(key, { signal: verdict, reason, source: 'prefilter', at });
    }
  }

  // Flag off, no provider, or nothing ambiguous ⇒ unsure persists as keep and
  // nothing leaves the box (spec §5).
  if (!opts.llm || unsure.length === 0) {
    for (const item of unsure) {
      const key = provenanceKey(String(item.source), item.sourceId);
      results.set(key, { signal: 'keep', reason: 'no deterministic signal', source: 'prefilter', at });
    }
    return results;
  }

  // Pass 2 — optional LLM over the unsure remainder only.
  const llmResults = await runLlmPass(
    unsure,
    opts.llm,
    rubric,
    opts.model,
    opts.maxItemsPerCall ?? DEFAULT_MAX_ITEMS_PER_CALL,
    at
  );
  for (const [key, result] of llmResults) results.set(key, result);
  return results;
}

/**
 * Run a set of already-staged items straight through the LLM triage pass,
 * skipping the prefilter — to catch frivolous cases the deterministic rules
 * miss (the inbox "LLM triage" action). Returns a `provenanceKey → TriageResult`
 * map; only items the model explicitly flags flip to `frivolous`, everything
 * else fails open to `keep`. A null/absent `llm` or empty input ⇒ empty map.
 */
export async function llmTriageItems(
  items: RawItem[],
  opts: TriageOpts = {}
): Promise<Map<string, TriageResult>> {
  if (!opts.llm || items.length === 0) return new Map();
  return runLlmPass(
    items,
    opts.llm,
    opts.rubric ?? DEFAULT_RUBRIC,
    opts.model,
    opts.maxItemsPerCall ?? DEFAULT_MAX_ITEMS_PER_CALL,
    nowIso()
  );
}
