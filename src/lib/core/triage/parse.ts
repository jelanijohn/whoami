/**
 * Strict parse + batch filter for LLM triage verdicts (triage spec §5).
 *
 * Trust nothing: parse strictly, then **drop any verdict whose `id` is not in
 * the batch's `validIds`** (the evidence-filter analog from `reduce/parse.ts`).
 * Any input id with no surviving verdict is the caller's problem — it fails open
 * to `keep`. The model can never invent an item or flip an unscored one.
 */

import { stripFence } from '../reduce/parse';

export interface Verdict {
  keep: boolean;
  reason: string;
}

/**
 * Parse a model reply into id → verdict, keeping only ids in `validIds`.
 * Throws if the reply is not valid JSON of the `{verdicts:[…]}` shape — the
 * caller catches per chunk and fails that chunk's items open to `keep` (§5).
 */
export function parseVerdicts(raw: string, validIds: Set<string>): Map<string, Verdict> {
  let data: unknown;
  try {
    data = JSON.parse(stripFence(raw));
  } catch {
    throw new Error('triage: model reply was not valid JSON');
  }
  const list = data && typeof data === 'object' ? (data as Record<string, unknown>).verdicts : undefined;
  if (!Array.isArray(list)) {
    throw new Error('triage: model reply had no "verdicts" array');
  }
  const out = new Map<string, Verdict>();
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.keep !== 'boolean') continue;
    if (!validIds.has(o.id)) continue; // drop ids outside the batch
    if (out.has(o.id)) continue; // first verdict wins on a duplicate id
    out.set(o.id, { keep: o.keep, reason: typeof o.reason === 'string' ? o.reason.trim() : '' });
  }
  return out;
}
