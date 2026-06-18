/**
 * Website import — Stage 2 extraction (website-import spec §5.2, §5.4).
 *
 * THE BOUNDARY (spec §0.1): this runs in the import-action layer, BEFORE
 * `stageItems`, exactly like `resume/pipeline.ts`. It is the one LLM call near
 * entry formation, over already-fetched, already-cleaned page text, and it only
 * *proposes* items. Stage 1 (`acquire.ts`) and `stageItems` stay LLM-free.
 *
 * It mirrors `parseResume`: concatenate the cleaned pages (each behind a
 * deterministic marker), chunk, one `llm.complete` per chunk, then the SHARED
 * `parseResumeItems` with website opts (source/tag/sourceId). The evidence
 * filter validates against the FULL concatenated text, so a span that reflowed
 * across a chunk boundary still verifies (spec §5.2). A bad chunk is reported,
 * never thrown.
 */

import type { Llm } from '../../types';
import type { RawItem } from '../types';
import { chunkResumeText } from '../resume/chunk';
import { parseResumeItems } from '../resume/parse';
import { buildWebsitePrompt } from './prompts';
import { websiteSourceId } from './parse';
import { WEBSITE_SOURCE, type FetchedPage } from './types';

export interface ParseWebsiteResult {
  items: RawItem[];
  /** Per-item drops (undated / unverifiable) and per-chunk failures — surfaced
   * so the owner knows what was skipped (spec §5.4). */
  errors: string[];
}

/** Collapse whitespace for the page-provenance match (same rule the evidence
 * filter uses, so a body that verified against the concatenated text can still
 * be located within a single page's cleaned text). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Run the website extraction over the fetched pages, returning proposed items
 * plus a report of everything dropped. Never throws on a bad chunk.
 */
export async function parseWebsite(
  llm: Llm,
  pages: FetchedPage[],
  opts: { tokenBudget?: number } = {}
): Promise<ParseWebsiteResult> {
  // Concatenate cleaned pages, each behind a deterministic marker line (spec
  // §5.2). The marker is part of the data block — harmless to the model, useful
  // as evidence text and for source-page provenance below.
  const fullText = pages
    .map((p) => `--- PAGE: ${p.finalUrl} ---\n${p.mainText}`)
    .join('\n\n');

  const chunks = chunkResumeText(fullText, { tokenBudget: opts.tokenBudget });
  const errors: string[] = [];
  const items: RawItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    let parsed: RawItem[] = [];
    try {
      const raw = await llm.complete(buildWebsitePrompt(chunks[i]));
      parsed = parseResumeItems(raw, fullText, errors, {
        source: WEBSITE_SOURCE,
        tag: 'website',
        makeSourceId: websiteSourceId
      });
    } catch (e) {
      errors.push(`chunk ${i + 1}/${chunks.length} failed: ${String(e)}`);
      continue;
    }
    for (const item of parsed) {
      if (seen.has(item.sourceId)) continue; // dedupe across chunks (spec §5.4)
      seen.add(item.sourceId);
      items.push(item);
    }
  }

  // Stamp each item's source page for traceability (spec §6): the finalUrl of
  // the first page whose cleaned text contains the verbatim excerpt.
  for (const item of items) {
    const needle = normalizeWs(item.body ?? '');
    if (!needle) continue;
    const page = pages.find((p) => normalizeWs(p.mainText).includes(needle));
    if (page) {
      item.extraFrontmatter = { ...(item.extraFrontmatter ?? {}), source_page: page.finalUrl };
    }
  }

  return { items, errors };
}
