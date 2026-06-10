/**
 * Strict parse + evidence filter (ingest-reduce plan §4.3).
 *
 * Parse strictly, then trust nothing: DROP any fact whose evidence references a
 * ULID outside the input set — an unverifiable claim does not survive, by
 * construction. A fact with no resolvable evidence is also dropped.
 */

import { RETRO_KEYS, type Fact, type Retrospective } from './schema';
import { emptyRetro } from './schema';

/** Strip a leading/trailing ```json … ``` code fence if the model added one. */
function stripFence(raw: string): string {
  const t = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return fenced ? fenced[1].trim() : t;
}

function asFact(v: unknown): Fact | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || !o.text.trim()) return null;
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : [];
  const fact: Fact = { text: o.text.trim(), evidence };
  if (typeof o.date === 'string') fact.date = o.date;
  return fact;
}

/**
 * Parse a model reply into a {@link Retrospective}. Throws if the reply is not
 * valid JSON of the closed shape — a malformed run fails visibly (plan §4.3).
 */
export function parseRetrospective(raw: string): Retrospective {
  let data: unknown;
  try {
    data = JSON.parse(stripFence(raw));
  } catch {
    throw new Error('reduce: model reply was not valid JSON');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('reduce: model reply was not a JSON object');
  }
  const o = data as Record<string, unknown>;
  const out = emptyRetro();
  for (const key of RETRO_KEYS) {
    const list = o[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(`reduce: "${key}" was not an array`);
    }
    out[key] = list.map(asFact).filter((f): f is Fact => f !== null);
  }
  return out;
}

/**
 * Keep only facts whose evidence is non-empty AND fully contained in
 * `validIds`. Returns a new retrospective; the input is not mutated.
 */
export function filterByEvidence(retro: Retrospective, validIds: Set<string>): Retrospective {
  const keep = (f: Fact): boolean =>
    f.evidence.length > 0 && f.evidence.every((id) => validIds.has(id));
  const out = emptyRetro();
  for (const key of RETRO_KEYS) {
    out[key] = retro[key].filter(keep);
  }
  return out;
}
