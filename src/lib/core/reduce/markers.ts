/**
 * App-owned marker region on the project entry body (ingest-reduce plan §4.4),
 * ported from waid's `upsert_marked_block`.
 *
 * The accepted reduction is written between two HTML-comment markers. Upsert
 * replaces the inner block wholesale if the markers exist, or appends the block
 * once if they don't — everything OUTSIDE the markers is preserved byte-for-byte
 * (the human's project prose is never touched). Re-running regenerates in place.
 */

export const REDUCE_START = '<!-- whoami:reduce:start -->';
export const REDUCE_END = '<!-- whoami:reduce:end -->';

/** Match the whole region (markers included), tolerant of surrounding blank
 * lines, non-greedy so only the first region is taken. */
const REGION_RE = new RegExp(
  `\\n*${escapeRe(REDUCE_START)}[\\s\\S]*?${escapeRe(REDUCE_END)}\\n*`
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if the body already carries a reduce region. */
export function hasMarkedBlock(body: string): boolean {
  return body.includes(REDUCE_START) && body.includes(REDUCE_END);
}

/** The inner content between the markers (trimmed), or '' if no region. */
export function extractMarkedBlock(body: string): string {
  const start = body.indexOf(REDUCE_START);
  const end = body.indexOf(REDUCE_END);
  if (start === -1 || end === -1 || end < start) return '';
  return body.slice(start + REDUCE_START.length, end).trim();
}

/**
 * Insert/replace the reduce region. `inner` is the rendered block WITHOUT
 * markers. Idempotent: re-running with the same inner yields the same body.
 */
export function upsertMarkedBlock(body: string, inner: string): string {
  const block = `${REDUCE_START}\n${inner.trim()}\n${REDUCE_END}`;
  if (hasMarkedBlock(body)) {
    return body.replace(REGION_RE, `\n\n${block}\n`).replace(/\n+$/, '\n');
  }
  const base = body.replace(/\s*$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Remove the reduce region entirely (ingest-reduce plan §4.5). The privacy
 * strip the generators apply unconditionally — far safer than tracking per-fact
 * privacy taint through LLM output.
 */
export function stripMarkedBlock(body: string): string {
  if (!hasMarkedBlock(body)) return body;
  return body
    .replace(REGION_RE, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
