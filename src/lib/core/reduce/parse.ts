/**
 * Strict parse + evidence filter (ingest-reduce plan §4.3).
 *
 * Parse strictly, then trust nothing: DROP any fact whose evidence references a
 * ULID outside the input set — an unverifiable claim does not survive, by
 * construction. A fact with no resolvable evidence is also dropped.
 */

import { RETRO_KEYS, type Fact, type Retrospective } from './schema';
import { emptyRetro } from './schema';

/** Strip a leading/trailing ```json … ``` code fence if the model added one.
 * Exported so sibling passes (e.g. `triage/`) reuse the same tolerant parse. */
export function stripFence(raw: string): string {
  const t = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return fenced ? fenced[1].trim() : t;
}

/**
 * Return the first top-level balanced `{…}` object in `text`, or null if there
 * is none. Lets us recover the JSON when the model wraps it in a prose preamble
 * ("Here is the retrospective:") despite the schema note — without falling for a
 * brace inside a string literal. Truncated replies have no balanced close, so
 * they correctly return null and fail visibly.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Build a diagnosable parse error: flag a likely truncation (no balanced
 * close — the §3.4 large-project failure) and quote the reply's tail so the
 * cause is visible instead of an opaque "not valid JSON". */
function malformedReply(raw: string): Error {
  const t = raw.trim();
  const looksTruncated = t.length > 0 && firstJsonObject(t) === null && t.includes('{');
  const tail = t.slice(-200).replace(/\s+/g, ' ');
  return new Error(
    'reduce: model reply was not valid JSON' +
      (looksTruncated ? ' (reply looks truncated — raise maxTokens)' : '') +
      ` [${t.length} chars; ends: …${tail}]`
  );
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
  const text = stripFence(raw);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Tolerate a prose preamble/trailer around the object before giving up.
    const slice = firstJsonObject(text);
    if (slice === null) throw malformedReply(raw);
    try {
      data = JSON.parse(slice);
    } catch {
      throw malformedReply(raw);
    }
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
