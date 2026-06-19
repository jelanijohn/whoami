/**
 * Strict parse + evidence filter for the wins draft pass (wins-from-journal
 * spec §2.3). Mirrors `reduce/parse.ts`: parse strictly, then trust nothing —
 * DROP any draft whose evidence is empty or references a ULID outside the
 * selected set, so an ungrounded claim cannot survive by construction.
 */

import { stripFence, firstJsonObject } from '../reduce/parse';
import { emptyWins, type WinDraft, type WinsPayload } from './schema';

/** Build a diagnosable parse error: flag a likely truncation (no balanced
 * close — the output overflowed maxTokens) and quote the reply's tail so the
 * cause is visible instead of an opaque "not valid JSON". Mirrors reduce's
 * `malformedReply`. */
function malformedReply(raw: string): Error {
  const t = raw.trim();
  const looksTruncated = t.length > 0 && firstJsonObject(t) === null && t.includes('{');
  const tail = t.slice(-200).replace(/\s+/g, ' ');
  return new Error(
    'wins: model reply was not valid JSON' +
      (looksTruncated ? ' (reply looks truncated — raise maxTokens)' : '') +
      ` [${t.length} chars; ends: …${tail}]`
  );
}

function asWin(v: unknown): WinDraft | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || !o.text.trim()) return null;
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : [];
  return { text: o.text.trim(), evidence };
}

/**
 * Parse a model reply into a {@link WinsPayload}. Tolerant of a prose preamble
 * (via {@link firstJsonObject}) and a code fence (via {@link stripFence}). A
 * reply that is not a JSON object throws a diagnosable error.
 */
export function parseWins(raw: string): WinsPayload {
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
    throw new Error('wins: model reply was not a JSON object');
  }
  const list = (data as Record<string, unknown>).wins;
  if (list === undefined) return emptyWins();
  if (!Array.isArray(list)) throw new Error('wins: "wins" was not an array');
  return { wins: list.map(asWin).filter((w): w is WinDraft => w !== null) };
}

/**
 * Keep only drafts whose evidence is non-empty AND fully contained in
 * `validIds`. Mirror of `filterByEvidence`. Returns a new array; input untouched.
 */
export function filterWinsByEvidence(payload: WinsPayload, validIds: Set<string>): WinDraft[] {
  return payload.wins.filter(
    (w) => w.evidence.length > 0 && w.evidence.every((id) => validIds.has(id))
  );
}
