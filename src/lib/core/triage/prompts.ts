/**
 * Prompt assembly for the optional LLM triage pass (triage spec §5).
 *
 * Same data-not-instructions discipline as `reduce/` (spec §1 rule 3): items go
 * inside a fenced DATA block with the verbatim {@link DATA_GUARD}, the owner's
 * `frivolousCriteria` drives the SYSTEM prompt, and the model is constrained to
 * a closed JSON schema. Each item's `id` is its `provenanceKey`, so a verdict
 * maps straight back to a candidate (and any id outside the batch is dropped at
 * parse time — see `parse.ts`).
 */

import type { LlmCompletionRequest } from '../types';
import type { RawItem } from '../ingest/types';
import { provenanceKey } from '../record';
import { DATA_GUARD } from '../reduce/prompts';
import type { TriageRubric } from './types';

/** Cap on the body excerpt serialized per item (spec §5). */
const BODY_CAP = 280;

const SCHEMA_NOTE =
  'Respond with ONLY a JSON object (no prose, no code fence) of this exact shape:\n' +
  '{"verdicts":[{"id": string, "keep": boolean, "reason": string}]}\n' +
  'Emit exactly one verdict per item in the DATA block, copying each "id" verbatim. ' +
  '"keep" is true when the item is worth keeping, false when it is frivolous. ' +
  '"reason" is a short human-readable justification. Classify every item; invent no ids.';

/** The view of one item the model sees — `id` is the provenance key the parser
 * validates against. Exported so the chunker measures the exact serialized text. */
export function triageItemView(item: RawItem): {
  id: string;
  source: string;
  date: string;
  title: string;
  body: string;
} {
  return {
    id: provenanceKey(String(item.source), item.sourceId),
    source: String(item.source),
    date: item.date,
    title: item.title,
    body: (item.body ?? '').slice(0, BODY_CAP)
  };
}

/** Build the batch-classifier request for one chunk of prefilter-`unsure` items.
 * `extraInstructions`, when present, is an extra natural-language steer the owner
 * typed for this run — appended to the rubric as additional SYSTEM guidance, kept
 * above {@link DATA_GUARD} so it counts as instructions, not item data. */
export function buildTriagePrompt(
  items: RawItem[],
  rubric: TriageRubric,
  extraInstructions?: string
): LlmCompletionRequest {
  const extra = extraInstructions?.trim();
  const system =
    'You triage candidate items for a personal professional history, labelling each ' +
    'as worth keeping or frivolous noise.\n' +
    rubric.frivolousCriteria +
    (extra ? `\n\nAdditional instructions from the record's owner:\n${extra}` : '') +
    '\n' +
    DATA_GUARD +
    '\n' +
    SCHEMA_NOTE;
  const data = JSON.stringify(items.map(triageItemView), null, 2);
  return {
    system,
    user: `<<<DATA\n${data}\n>>>END_DATA\n\nClassify every item above as keep or frivolous.`
  };
}
