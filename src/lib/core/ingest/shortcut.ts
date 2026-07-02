/**
 * Shortcut — two features share this module (shortcut-enrichment spec +
 * shortcut-story-import spec, both Stage 1):
 *
 * 1. **Enrichment** of GitHub items: commits/PRs on agency-client projects
 *    reference a Shortcut story in the message (`sc-57886`); we (a) extract
 *    that reference deterministically (pure, token-free, always-on) and
 *    (b) enrich ref-tagged items with the story's metadata through the Http
 *    seam when a token is present. Enriched candidates keep `source: 'github'`
 *    and their GitHub `source_id` — the dedupe identity is unchanged.
 * 2. **Story import**: Shortcut is also an {@link IngestSource} of its own — a
 *    windowed Query-Stories fetch, filtered client-side to stories the token's
 *    member *follows* (followership accretes: owners, requesters, and
 *    commenters are auto-added and persist after reassignment, so it captures
 *    reassigned-away work). Story candidates carry `source: 'shortcut'` /
 *    `source_id = story.id`, so they never collide with enriched commits.
 *    Both entry kinds share the same `shortcut` frontmatter object (via
 *    {@link storyFrontmatter}) — the deterministic Stage-2 join key.
 *
 * The two-stage boundary holds: everything here is deterministic acquisition
 * (no LLM). The ticket roll-up that collapses N same-ticket commits into one
 * entry is a separate Stage-2 synthesis; the `shortcut_ids` tag written by
 * enrichment is what makes that grouping deterministic later.
 *
 * Story text (name/description) is provider data, never instructions: it rides
 * inside the `--- Shortcut ---` / `--- Description ---` delimited blocks so the
 * reduce stage's fencing wraps it as data (per `types.ts` security stance).
 */

import type { Http } from '../types';
import { getJson, postJson } from './http';
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
  project?: string; // resolved project NAME, else undefined
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
  projects: Map<number | string, string>;
}

/** Description cap — the same bounded-verbatim idiom as Asana's `notesSnippet`
 * (spec §8): cut at the last whitespace within the cap, append a marker. */
const DESCRIPTION_CAP = 500;

/** The cap the story *import* maps descriptions through (import spec D6). For
 * an imported story the description IS the primary body, so it gets the
 * GitHub-discussion-sized bound; enrichment keeps its 500-char default. */
export const IMPORT_DESCRIPTION_CAP = 2000;

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
 * default, spec D2) drops the description entirely. `cap` bounds the kept
 * description (default 500 — the enrichment behavior); the story import passes
 * {@link IMPORT_DESCRIPTION_CAP}. */
export function mapShortcutStory(
  raw: unknown,
  resolve: ShortcutResolve,
  opts: { includeDescription?: boolean; cap?: number } = {}
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
  const project = resolveName(resolve.projects, get(raw, 'project_id'));
  if (project) story.project = project;
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
    if (description) story.description = descriptionSnippet(description, opts.cap);
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

/** Fetch the four id→name resolution maps, one cached call each (spec §3.4):
 * `/workflows` (flattened `states[]`), `/epics`, `/groups`, `/projects`. A full
 * enrichment run therefore costs 4 + N-distinct-stories calls, independent of
 * how many commits referenced each ticket. (`/projects` 404s on workspaces
 * with Projects disabled — `fetchNameMap` degrades that to an empty map.) */
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
  const projects = await fetchNameMap(http, token, `${BASE}/projects`, (json) => list(json).map(idName));
  return { states, epics, teams, projects };
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
 * The `shortcut` frontmatter object — the ONE builder both entry kinds share
 * (import spec §4.5): enrichment writes it verbatim onto GitHub items, the
 * story import writes it (plus `roles`) onto story items. The identical shape
 * on both is the deterministic Stage-2 join key, so this must stay the single
 * source of truth. Only defined fields are carried — no `undefined` schema
 * noise. Pure — pinned byte-identical by the enrichment fixtures.
 */
export function storyFrontmatter(story: ShortcutStory): { shortcut: Record<string, unknown> } {
  const shortcut: Record<string, unknown> = { id: story.id };
  if (story.type) shortcut.type = story.type;
  if (story.state) shortcut.state = story.state;
  if (story.epic) shortcut.epic = story.epic;
  if (story.team) shortcut.team = story.team;
  if (story.project) shortcut.project = story.project;
  if (story.createdAt) shortcut.created_at = story.createdAt;
  if (story.startedAt) shortcut.started_at = story.startedAt;
  if (story.completedAt) shortcut.completed_at = story.completedAt;
  if (story.appUrl) shortcut.app_url = story.appUrl;
  if (story.labels?.length) shortcut.labels = story.labels;
  if (story.estimate !== undefined) shortcut.estimate = story.estimate;
  return { shortcut };
}

/**
 * Shape a story into the frontmatter facts + the verbatim body block — the ONE
 * source of truth both the at-import path and the inbox backfill write. Pure —
 * fixture-tested. `frontmatter` holds our computed facts (rides
 * extraFrontmatter / entry frontmatter, snake_case sub-keys like `change_size`);
 * `bodyBlock` is the `--- Shortcut ---` delimited block (provider text, fenced
 * as data). The story name rides the header line (title is metadata); the
 * bounded description, when present, follows verbatim. Note `completed_at` is
 * surfaced as a fact for the Stage-2 roll-up, never written over the entry
 * `date`.
 */
export function shortcutEnrichment(story: ShortcutStory): {
  frontmatter: Record<string, unknown>;
  bodyBlock: string;
} {
  const qualifiers = [story.type, story.state].filter(Boolean).join(', ');
  const lines = [
    BLOCK_HEADER,
    `sc-${story.id}${qualifiers ? ` (${qualifiers})` : ''}: ${story.name}`
  ];
  if (story.epic) lines.push(`Epic: ${story.epic}`);
  if (story.description) lines.push(story.description);
  return { frontmatter: storyFrontmatter(story), bodyBlock: lines.join('\n') };
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

// --- Story import (shortcut-story-import spec) -------------------------------

/** The token's own member — the identity the involvement predicate and the
 * provable roles are computed against (import spec §4.1). */
export interface ShortcutMe {
  id: string;
  mentionName: string;
  name: string;
}

/** GET /member → {@link ShortcutMe}. Unlike the enrichment lookups, a missing
 * `id` THROWS — the import cannot proceed without an identity. */
export async function fetchShortcutMe(http: Http, token: string): Promise<ShortcutMe> {
  const json = await getJson(http, `${BASE}/member`, shortcutHeaders(token), 'Shortcut');
  const id = asStr(get(json, 'id'));
  if (!id) throw new Error('Shortcut /member returned no member id.');
  return {
    id,
    mentionName: asStr(get(json, 'mention_name')) ?? '',
    name: asStr(get(json, 'name')) ?? ''
  };
}

/** Cheap credential check, symmetric with validateGithub/validateAsana:
 * GET /member returns the token's owner. */
export async function validateShortcut(http: Http, token: string): Promise<void> {
  await fetchShortcutMe(http, token);
}

/** The provable involvement roles, recorded deterministically (import spec D5).
 * `'follower'` is always present — it is the selection predicate. */
export type ShortcutRole = 'owner' | 'requester' | 'follower';

/** The involvement predicate (import spec D1): `myId ∈ follower_ids`, evaluated
 * client-side (the API has no server-side follower filter). Followership
 * accretes — owners, requesters, and commenters are auto-added and persist
 * after reassignment — so it is the superset that captures reassigned-away
 * work. Missing/malformed `follower_ids` ⇒ false (fail closed: never import
 * someone else's story by accident). Pure. */
export function storyInvolvesMe(raw: unknown, myId: string): boolean {
  const followers = get(raw, 'follower_ids');
  if (!Array.isArray(followers)) return false;
  return followers.some((f) => asStr(f) === myId);
}

/** The provable roles on a story payload (import spec D5): `'owner'` iff
 * `myId ∈ owner_ids`, `'requester'` iff `requested_by_id === myId`,
 * `'follower'` always last. Order fixed for deterministic frontmatter. Keeps
 * the record brutally accurate about *did* vs *watched* without an LLM. Pure. */
export function storyRoles(raw: unknown, myId: string): ShortcutRole[] {
  const roles: ShortcutRole[] = [];
  const owners = get(raw, 'owner_ids');
  if (Array.isArray(owners) && owners.some((o) => asStr(o) === myId)) roles.push('owner');
  if (asStr(get(raw, 'requested_by_id')) === myId) roles.push('requester');
  roles.push('follower');
  return roles;
}

/** An `updated_at` acquisition window, YYYY-MM-DD inclusive (import spec D2).
 * `updated_at` (not `created_at`) so rolling feeds catch stories whose
 * relevance changed in the window; re-fetch overlap is harmless (dedupe). */
export interface ShortcutWindow {
  since?: string;
  until?: string;
}

/** YYYY-MM-DD → the full ISO date-time the search body requires (§2). */
function isoBound(date: string, edge: 'start' | 'end'): string {
  return edge === 'start' ? `${date}T00:00:00Z` : `${date}T23:59:59Z`;
}

/** Split a window at its temporal midpoint into adjacent, non-overlapping
 * halves (UTC epoch-day arithmetic). Pure — unit-tested. A 1-day window yields
 * a left half identical to the input (no progress possible), which the caller's
 * depth/same-window guard turns into a reported truncation. */
export function bisectWindow(since: string, until: string): [ShortcutWindow, ShortcutWindow] {
  const dayMs = 86_400_000;
  const s = Date.parse(`${since}T00:00:00Z`);
  const u = Date.parse(`${until}T00:00:00Z`);
  const midMs = s + Math.floor((u - s) / dayMs / 2) * dayMs;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [
    { since, until: iso(midMs) },
    { since: iso(midMs + dayMs), until }
  ];
}

/** Query Stories caps (and does not paginate past) 1,000 results — a response
 * of exactly the cap is treated as truncation and bisected (import spec D3). */
const QUERY_CAP = 1000;
const MAX_BISECT_DEPTH = 8;

/**
 * Windowed acquisition (import spec §4.3): one `POST /stories/search` per
 * window with `includes_description: true` and ISO `updated_at` bounds. No
 * `archived` key (D4 — archived stories are exactly the failures-and-lessons
 * material the record exists to keep); no owner/requester filters (D1's
 * follower predicate subsumes them). A cap-length response bisects the window
 * recursively; an unsplittable window's truncation is pushed onto
 * `opts.errors` — never silently dropped. An open-bound cap-length response
 * throws (the caller must set an explicit window before bisection can work).
 */
export async function queryShortcutStories(
  http: Http,
  token: string,
  window: ShortcutWindow,
  opts: { errors?: string[]; depth?: number } = {}
): Promise<unknown[]> {
  const body: Record<string, unknown> = {
    includes_description: true,
    ...(window.since ? { updated_at_start: isoBound(window.since, 'start') } : {}),
    ...(window.until ? { updated_at_end: isoBound(window.until, 'end') } : {})
  };
  const json = await postJson(http, `${BASE}/stories/search`, shortcutHeaders(token), body, 'Shortcut');
  const stories = Array.isArray(json) ? json : [];
  if (stories.length < QUERY_CAP) return stories;

  if (!window.since || !window.until) {
    throw new Error(
      'Shortcut returned the 1,000-story cap for an open-ended window — set an explicit since and until, then re-run.'
    );
  }
  const depth = opts.depth ?? 0;
  if (depth >= MAX_BISECT_DEPTH || window.since === window.until) {
    opts.errors?.push(
      `Shortcut window ${window.since}..${window.until} hit the 1,000-story cap and cannot be split further — results are truncated.`
    );
    return stories;
  }
  const [left, right] = bisectWindow(window.since, window.until);
  const next = { ...opts, depth: depth + 1 };
  return [
    ...(await queryShortcutStories(http, token, left, next)),
    ...(await queryShortcutStories(http, token, right, next))
  ];
}

/**
 * Map one story + its roles into a RawItem (import spec §4.6). Pure —
 * fixture-tested. `source: 'shortcut'` / `sourceId = story.id` (the stable
 * numeric public id) never collides with enriched commits' `(github, sha)`.
 * The body is the bounded description in the sibling adapters' delimiter idiom
 * (provider data, fenced by the reduce stage). The frontmatter is the SAME
 * `shortcut` object enrichment writes (the Stage-2 join key) plus `roles` —
 * and deliberately NO `shortcut_ids` key: that key is the enrichment trigger
 * on GitHub items, and its absence is what guarantees a story item is never
 * re-enriched with itself.
 */
export function mapShortcutStoryToRawItem(story: ShortcutStory, roles: ShortcutRole[]): RawItem {
  const item: RawItem = {
    source: 'shortcut',
    sourceId: story.id,
    title: story.name,
    // Event date: completion is "when the thing happened", else the start,
    // else creation (every story has created_at).
    date: story.completedAt ?? story.startedAt ?? story.createdAt ?? '',
    suggestedType: 'journal',
    suggestedTags: ['shortcut', ...(story.type ? [story.type] : [])],
    extraFrontmatter: { shortcut: { ...storyFrontmatter(story).shortcut, roles } }
  };
  if (story.appUrl) item.url = story.appUrl;
  if (story.description) item.body = `--- Description ---\n${story.description}`;
  return item;
}

/**
 * The story-import adapter entry point (import spec §4.7): resolve me → query
 * the window → keep only stories I follow → map each through the resolution
 * maps into a RawItem with its provable roles. The maps are fetched once per
 * run, and only after the filter confirms ≥ 1 match (a zero-match run costs 2
 * requests total). Per-item mapping failures land on `opts.errors`, never
 * abort the batch. Request budget: 1 (member) + windows-after-bisection + 4
 * (maps) — comfortably under the 200/min limit for any sane window.
 */
export async function fetchShortcutStoryItems(
  http: Http,
  token: string,
  window: ShortcutWindow,
  opts: { errors?: string[] } = {}
): Promise<RawItem[]> {
  const me = await fetchShortcutMe(http, token);
  const raws = await queryShortcutStories(http, token, window, { errors: opts.errors });
  const mine = raws.filter((raw) => storyInvolvesMe(raw, me.id));
  if (mine.length === 0) return [];
  const resolve = await fetchShortcutResolutionMaps(http, token);
  const items: RawItem[] = [];
  for (const raw of mine) {
    try {
      const story = mapShortcutStory(raw, resolve, {
        includeDescription: true,
        cap: IMPORT_DESCRIPTION_CAP
      });
      items.push(mapShortcutStoryToRawItem(story, storyRoles(raw, me.id)));
    } catch (e) {
      opts.errors?.push(`Shortcut story skipped: ${String(e)}`);
    }
  }
  return items;
}
