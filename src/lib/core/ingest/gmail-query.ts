/**
 * Gmail search-query helper — port of waid's `generate_gmail_query`.
 *
 * Turns a plain-English description ("unread from my manager this week") into
 * a single-line Gmail search query via the Llm seam. Unlike triage/reduce
 * prompts there is deliberately **no DATA_GUARD** here: the input is the
 * owner's own request, not imported content, so it *is* instructions. Safety
 * comes from pinning the output to one line and sanitizing it.
 *
 * Everything here is pure except {@link suggestGmailQuery}, which only calls
 * the injected `Llm` — no Platform, secrets, record, or index access.
 */

import type { Llm, LlmCompletionRequest } from '../types';

/** Verbatim from waid's `gmail_query_system_prompt()`. */
export const GMAIL_QUERY_SYSTEM = `You convert a person's plain-English description of emails they want to see into a single Gmail search query built from Gmail's search operators.

RULES:
- Output ONLY the query, on one line. No explanation, no quotes, no code fences, no trailing period.
- Use Gmail operators where they fit: from:, to:, cc:, subject:, label:, category:(primary|social|promotions|updates|forums), has:attachment, filename:, is:(unread|read|starred|important), in:(inbox|anywhere), newer_than:Nd / older_than:Nd (also h/m/y), after:YYYY/MM/DD, before:YYYY/MM/DD, larger:, smaller:, and -term to exclude. Group OR alternatives with {a b} or parentheses.
- When the request implies 'recent' or a timeframe, add a bound like newer_than:7d.
- If it names a person or company but no address, use a bare name token (from:acme), never an invented email.
- If the request is vague, produce a sensible broad query rather than nothing.
- Never invent operators that don't exist.`;

/** Cap on the description we forward — a query request never needs more. */
const MAX_DESCRIPTION_CHARS = 2000;

/** Build the completion request for a description. Pure. */
export function buildGmailQueryPrompt(description: string): LlmCompletionRequest {
  return {
    system: GMAIL_QUERY_SYSTEM,
    user: description.trim().slice(0, MAX_DESCRIPTION_CHARS),
    maxTokens: 200
  };
}

/** Labels a chatty model might prefix the query with — stripped; real Gmail
 * operators (from:, subject:, …) are not in this list and survive. */
const LABEL_PREFIX = /^(?:query|search|gmail|result|answer|output)\s*:\s*/i;

/**
 * Port of waid's `sanitize_search_query`: take the first non-empty line that
 * isn't a code fence, strip wrapping backticks/quotes and a leading
 * `query:`-style label. Returns '' when nothing usable remains.
 */
export function sanitizeSearchQuery(raw: string): string {
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s || s.startsWith('```')) continue;
    s = s.replace(/^[`"']+/, '').replace(/[`"']+$/, '').trim();
    s = s.replace(LABEL_PREFIX, '').trim();
    if (s) return s;
  }
  return '';
}

/** Describe → complete → sanitize. Throws when the description is empty or
 * the model produced nothing usable (mirrors waid's command errors). */
export async function suggestGmailQuery(llm: Llm, description: string): Promise<string> {
  const desc = description.trim();
  if (!desc) throw new Error('Describe the emails you want first.');
  const raw = await llm.complete(buildGmailQueryPrompt(desc));
  const query = sanitizeSearchQuery(raw);
  if (!query) throw new Error("The model didn't return a usable search.");
  return query;
}
