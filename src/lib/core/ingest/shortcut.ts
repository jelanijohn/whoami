/**
 * Shortcut enrichment (shortcut-enrichment spec, Stage 1) — NOT a standalone
 * ingest source. GitHub commits/PRs on agency-client projects reference a
 * Shortcut story in the message (`sc-57886`); this module (a) extracts that
 * reference deterministically (pure, token-free, always-on) and (b) enriches
 * ref-tagged items with the story's metadata through the Http seam when a
 * token is present. Enriched candidates keep `source: 'github'` and their
 * GitHub `source_id` — the dedupe identity is unchanged.
 *
 * The two-stage boundary holds: everything here is deterministic acquisition
 * (no LLM). The ticket roll-up that collapses N same-ticket commits into one
 * entry is a separate Stage-2 synthesis; the `shortcut_ids` tag written here
 * is what makes that grouping deterministic later.
 *
 * Story text (name/description) is provider data, never instructions: it rides
 * inside the `--- Shortcut ---` delimited block so the reduce stage's fencing
 * wraps it as data (per `types.ts` security stance).
 */

import type { Http } from '../types';
import { getJson } from './http';
import { asNum, asStr, get, isoDate, type RawItem } from './types';

const BASE = 'https://api.app.shortcut.com/api/v3';

/** Default Shortcut reference pattern: `sc-<digits>`, case-insensitive,
 * word-bounded (the bounding is applied at compile time, so `disc-123` never
 * matches). Owner-overridable per feed (spec D5). */
export const DEFAULT_SHORTCUT_REF = 'sc-\\d+';

/** Header builder for Shortcut. NOT bearer — Shortcut authenticates with a
 * `Shortcut-Token` header, so it cannot reuse `bearer()`. */
function shortcutHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Shortcut-Token': token };
}

/**
 * Extract distinct Shortcut story ids from arbitrary text (title + body), in
 * first-seen order. Pure — fixture-tested. `patternSource` is a regex *source*
 * (no flags); an invalid source never throws — it yields [] (a bad override
 * must never abort an import, matching the `matches()` guard in
 * `triage/prefilter.ts`). The numeric id is returned WITHOUT the `sc-` prefix
 * (e.g. "57886"): when the source has a capture group that group is the id,
 * otherwise the trailing digit run of the match is.
 */
export function extractShortcutRefs(text: string, patternSource = DEFAULT_SHORTCUT_REF): string[] {
  let re: RegExp;
  try {
    // Word-bound the whole source so ids embedded in longer words/SHAs (e.g.
    // `disc-123`, `sc-123abc`) never match.
    re = new RegExp(`\\b(?:${patternSource})\\b`, 'gi');
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const digits = m[1] ?? /(\d+)$/.exec(m[0])?.[1];
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }
  return out;
}

/** One Shortcut story, reduced to the field allowlist (spec D2/§8): metadata
 * only — comments, attachments, custom fields, and member PII are never
 * fetched. `description` is populated only when `includeDescription` is on. */
export interface ShortcutStory {
  id: string;
  name: string;
  type?: string; // story_type: feature | bug | chore
  state?: string; // resolved workflow state NAME (see resolution maps)
  epic?: string; // resolved epic NAME, else undefined
  team?: string; // resolved group/team NAME, else undefined
  appUrl?: string; // app_url
  createdAt?: string; // YYYY-MM-DD
  startedAt?: string; // YYYY-MM-DD
  completedAt?: string; // YYYY-MM-DD
  labels?: string[];
  estimate?: number;
  description?: string; // verbatim, bounded; only when includeDescription is on
}

/** The pre-fetched id→name resolution maps a story's numeric/uuid ids resolve
 * through, so {@link mapShortcutStory} stays network-free. (Workflow-state and
 * epic ids are numeric; group ids are UUID strings — the union covers both.) */
export interface ShortcutResolve {
  states: Map<number | string, string>;
  epics: Map<number | string, string>;
  teams: Map<number | string, string>;
}

/** Description cap — the same bounded-verbatim idiom as Asana's `notesSnippet`
 * (spec §8): cut at the last whitespace within the cap, append a marker. */
const DESCRIPTION_CAP = 500;

function descriptionSnippet(description: string, cap = DESCRIPTION_CAP): string {
  const trimmed = description.trim();
  if (trimmed.length <= cap) return trimmed;
  const hard = trimmed.slice(0, cap);
  const m = hard.match(/^[\s\S]*\s/); // greedy through the last whitespace
  const head = (m ? m[0] : hard).trimEnd();
  return `${head}\n\n… [description truncated at ${cap} chars]`;
}

/** Look one raw id (number or UUID string) up in a resolution map. */
function resolveName(map: Map<number | string, string>, rawId: unknown): string | undefined {
  return typeof rawId === 'number' || typeof rawId === 'string' ? map.get(rawId) : undefined;
}

/** Map one raw Shortcut story payload → {@link ShortcutStory}. Pure —
 * fixture-tested. Resolution maps are passed in pre-fetched; an unresolvable id
 * degrades to `undefined`, never throws. `includeDescription=false` (the
 * default, spec D2) drops the description entirely. */
export function mapShortcutStory(
  raw: unknown,
  resolve: ShortcutResolve,
  opts: { includeDescription?: boolean } = {}
): ShortcutStory {
  const rawId = get(raw, 'id');
  const story: ShortcutStory = {
    id: rawId == null ? '' : String(rawId),
    name: asStr(get(raw, 'name')) ?? ''
  };
  const type = asStr(get(raw, 'story_type'));
  if (type) story.type = type;
  const state = resolveName(resolve.states, get(raw, 'workflow_state_id'));
  if (state) story.state = state;
  const epic = resolveName(resolve.epics, get(raw, 'epic_id'));
  if (epic) story.epic = epic;
  const team = resolveName(resolve.teams, get(raw, 'group_id'));
  if (team) story.team = team;
  const appUrl = asStr(get(raw, 'app_url'));
  if (appUrl) story.appUrl = appUrl;
  const createdAt = isoDate(get(raw, 'created_at'));
  if (createdAt) story.createdAt = createdAt;
  const startedAt = isoDate(get(raw, 'started_at'));
  if (startedAt) story.startedAt = startedAt;
  const completedAt = isoDate(get(raw, 'completed_at'));
  if (completedAt) story.completedAt = completedAt;
  const labels = get(raw, 'labels');
  if (Array.isArray(labels)) {
    const names = labels.map((l) => asStr(get(l, 'name'))).filter((n): n is string => !!n);
    if (names.length) story.labels = names;
  }
  const estimate = asNum(get(raw, 'estimate'));
  if (estimate !== undefined) story.estimate = estimate;
  if (opts.includeDescription === true) {
    const description = asStr(get(raw, 'description'))?.trim();
    if (description) story.description = descriptionSnippet(description);
  }
  return story;
}

/** Fetch one id→name resolution map, degrading to an empty map on any failure
 * (an unresolved name is `undefined`; a down endpoint never blocks the run). */
async function fetchNameMap(
  http: Http,
  token: string,
  url: string,
  entries: (json: unknown) => Array<[unknown, string | undefined]>
): Promise<Map<number | string, string>> {
  const map = new Map<number | string, string>();
  try {
    const json = await getJson(http, url, shortcutHeaders(token), 'Shortcut');
    for (const [id, name] of entries(json)) {
      if ((typeof id === 'number' || typeof id === 'string') && name) map.set(id, name);
    }
  } catch {
    /* degrade gracefully — names stay undefined */
  }
  return map;
}

/** Fetch the three id→name resolution maps, one cached call each (spec §3.4):
 * `/workflows` (flattened `states[]`), `/epics`, `/groups`. A full enrichment
 * run therefore costs 3 + N-distinct-stories calls, independent of how many
 * commits referenced each ticket. */
export async function fetchShortcutResolutionMaps(http: Http, token: string): Promise<ShortcutResolve> {
  const list = (json: unknown): unknown[] => (Array.isArray(json) ? json : []);
  const idName = (v: unknown): [unknown, string | undefined] => [get(v, 'id'), asStr(get(v, 'name'))];
  const states = await fetchNameMap(http, token, `${BASE}/workflows`, (json) =>
    list(json).flatMap((w) => {
      const s = get(w, 'states');
      return Array.isArray(s) ? s.map(idName) : [];
    })
  );
  const epics = await fetchNameMap(http, token, `${BASE}/epics`, (json) => list(json).map(idName));
  const teams = await fetchNameMap(http, token, `${BASE}/groups`, (json) => list(json).map(idName));
  return { states, epics, teams };
}

/**
 * Fetch distinct stories by id. Dedupes `ids` before any request, so the same
 * ticket referenced by 15 commits costs ONE GET. Per-id failures are swallowed
 * (a 404/deleted story yields no entry — it never aborts the batch). Returns a
 * Map keyed by story id.
 */
export async function fetchShortcutStories(
  http: Http,
  token: string,
  ids: string[],
  opts: { includeDescription?: boolean } = {}
): Promise<Map<string, ShortcutStory>> {
  const distinct = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, ShortcutStory>();
  if (distinct.length === 0) return out;
  const resolve = await fetchShortcutResolutionMaps(http, token);
  for (const id of distinct) {
    try {
      const raw = await getJson(http, `${BASE}/stories/${id}`, shortcutHeaders(token), 'Shortcut');
      out.set(id, mapShortcutStory(raw, resolve, opts));
    } catch {
      /* skip this story; the batch continues */
    }
  }
  return out;
}

/** The `--- Shortcut ---` block delimiter — the same idiom as
 * `--- Description ---` / `--- Message ---`, so the block is fenced as
 * provider data by the reduce stage. */
const BLOCK_HEADER = '--- Shortcut ---';

/** Strip an existing `--- Shortcut ---` block (it is always appended last) so
 * re-enriching updates the block instead of duplicating it. Pure. */
export function stripShortcutBlock(body: string): string {
  const idx = body.indexOf(BLOCK_HEADER);
  if (idx < 0) return body;
  return body.slice(0, idx).replace(/\s+$/, '');
}

/**
 * Shape a story into the frontmatter facts + the verbatim body block — the ONE
 * source of truth both the at-import path and the inbox backfill write. Pure —
 * fixture-tested. `frontmatter` holds our computed facts (rides
 * extraFrontmatter / entry frontmatter, snake_case sub-keys like `change_size`);
 * `bodyBlock` is the `--- Shortcut ---` delimited block (provider text, fenced
 * as data). The story name rides the header line (title is metadata); the
 * bounded description, when present, follows verbatim. Only defined fields are
 * carried — no `undefined` schema noise. Note `completed_at` is surfaced as a
 * fact for the Stage-2 roll-up, never written over the entry `date`.
 */
export function shortcutEnrichment(story: ShortcutStory): {
  frontmatter: Record<string, unknown>;
  bodyBlock: string;
} {
  const shortcut: Record<string, unknown> = { id: story.id };
  if (story.type) shortcut.type = story.type;
  if (story.state) shortcut.state = story.state;
  if (story.epic) shortcut.epic = story.epic;
  if (story.team) shortcut.team = story.team;
  if (story.createdAt) shortcut.created_at = story.createdAt;
  if (story.startedAt) shortcut.started_at = story.startedAt;
  if (story.completedAt) shortcut.completed_at = story.completedAt;
  if (story.appUrl) shortcut.app_url = story.appUrl;
  if (story.labels?.length) shortcut.labels = story.labels;
  if (story.estimate !== undefined) shortcut.estimate = story.estimate;

  const qualifiers = [story.type, story.state].filter(Boolean).join(', ');
  const lines = [
    BLOCK_HEADER,
    `sc-${story.id}${qualifiers ? ` (${qualifiers})` : ''}: ${story.name}`
  ];
  if (story.epic) lines.push(`Epic: ${story.epic}`);
  if (story.description) lines.push(story.description);
  return { frontmatter: { shortcut }, bodyBlock: lines.join('\n') };
}

/**
 * Enrich a batch of RawItems in place from Shortcut (the at-import path, spec
 * D1). Collects distinct ids across ALL items (from
 * `item.extraFrontmatter.shortcut_ids`), fetches each story once, and folds the
 * first resolved story's facts into the matching items' extraFrontmatter +
 * appends its bodyBlock. Items with no ref (or whose story fetch failed) are
 * untouched. Returns the same array (mutated) for chaining.
 */
export async function enrichRawItemsWithShortcut(
  http: Http,
  token: string,
  items: RawItem[],
  opts: { includeDescription?: boolean } = {}
): Promise<RawItem[]> {
  const refsOf = (item: RawItem): string[] => {
    const ids = item.extraFrontmatter?.shortcut_ids;
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [];
  };
  const all = items.flatMap(refsOf);
  if (all.length === 0) return items;
  const stories = await fetchShortcutStories(http, token, all, opts);
  for (const item of items) {
    const story = refsOf(item)
      .map((id) => stories.get(id))
      .find((s) => s !== undefined);
    if (!story) continue;
    const { frontmatter, bodyBlock } = shortcutEnrichment(story);
    item.extraFrontmatter = { ...(item.extraFrontmatter ?? {}), ...frontmatter };
    const base = stripShortcutBlock(item.body ?? '');
    item.body = base ? `${base}\n\n${bodyBlock}` : bodyBlock;
  }
  return items;
}

/** Cheap credential check, symmetric with validateGithub/validateAsana:
 * GET /member returns the token's owner; any 200 confirms the token. */
export async function validateShortcut(http: Http, token: string): Promise<void> {
  await getJson(http, `${BASE}/member`, shortcutHeaders(token), 'Shortcut');
}
