/**
 * Ticket grouping & merge-at-promote — the pure core (merge spec §1).
 *
 * Repeated small commits/PRs against one Shortcut ticket flood the inbox; the
 * natural unit of work is the ticket, the ingest unit is the commit. This
 * module re-chunks at the review gate: {@link buildMergedEntry} collapses N
 * selected same-source candidates into ONE record entry carrying multi-row
 * provenance (`source_ids`), so re-imports still skip every constituent.
 *
 * Everything here is pure (the adapter/mapper idiom — data in, data out,
 * fixture-tested) and fully deterministic: no LLM anywhere in this feature
 * (spec §6.1). The impure shell is `RecordStore.promoteMerged`.
 */

import type { Entry } from './types';
import { makeEntry } from './entry';
import { DEFAULT_SHORTCUT_REF, stripShortcutBlock } from './ingest/shortcut';
import { TRIAGE_KEYS } from './triage/types';

/** Frontmatter the human sets/overrides in the merge preview dialog (spec
 * §1.3). Same semantics as `PromoteOverrides` where fields overlap. */
export interface MergeOverrides {
  /** Final title. Required — the UI seeds it from {@link mergedTitleDefault}. */
  title: string;
  /** YYYY-MM-DD. Optional; when absent the merged date is the max valid
   * constituent date. At least one of (override, ≥1 valid constituent date)
   * must exist or the build THROWS — the promote date gate holds (never
   * defaults to today). */
  date?: string;
  /** Same semantics as PromoteOverrides.project: empty string clears;
   * `undefined` → the constituents' shared suggestion if all agree, else unset. */
  project?: string;
  /** Parent entry ULID to nest under; carried only when non-empty. */
  parent?: string;
  /** Tags unioned with the constituents' own tags (deduped, existing first). */
  tags?: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHORTCUT_BLOCK = '--- Shortcut ---';
/** Header-line format is OURS (`shortcutEnrichment`):
 * `sc-{id}( ({qualifiers}))?: {name}` — parsed, never guessed (spec §1.4). */
const SHORTCUT_HEADER = /^sc-(\d+)(?:\s*\([^)]*\))?:\s*(.+)$/m;

const titleOf = (c: Entry): string =>
  typeof c.frontmatter.title === 'string' ? c.frontmatter.title : '';
const dateOf = (c: Entry): string =>
  typeof c.frontmatter.date === 'string' && ISO_DATE.test(c.frontmatter.date)
    ? c.frontmatter.date
    : '';
const sourceIdOf = (c: Entry): string =>
  typeof c.frontmatter.source_id === 'string' ? c.frontmatter.source_id : '';

// --- Grouping accessors (spec §1.1–1.2) --------------------------------------

/**
 * The primary grouping key (D1): the Shortcut ticket a candidate references.
 * Reads `frontmatter.shortcut_ids[0]` (enriched GitHub items), falling back to
 * `frontmatter.shortcut.id` (imported story items). Returns the bare numeric id
 * (no `sc-` prefix) — matching `extractShortcutRefs` output — or `''`.
 */
export function ticketOf(c: Entry): string {
  const fm = c.frontmatter as Record<string, unknown>;
  const ids = fm.shortcut_ids;
  if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string' && ids[0]) {
    return ids[0];
  }
  const sc = fm.shortcut;
  if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
    const id = (sc as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
  }
  return '';
}

/** Replace every word-bounded ref match with a space — the same compilation
 * guard as `extractShortcutRefs`: an invalid source strips nothing, never
 * throws (a bad override must never break grouping). */
function stripRefs(text: string, patternSource: string): string {
  try {
    return text.replace(new RegExp(`\\b(?:${patternSource})\\b`, 'gi'), ' ');
  } catch {
    return text;
  }
}

/**
 * The D1 fallback grouping key for ticketless candidates: lowercase, Shortcut
 * refs stripped, every run of non-alphanumerics collapsed to a single space.
 * Refs are stripped both as written (`sc-57886`) and in collapsed form
 * (`sc 57886`), so separator variants of the same ref normalize to the same
 * key. A title that was *only* a ticket ref yields `''` (such candidates group
 * by their ticket anyway). No spell-correction — brutal accuracy extends to
 * typos.
 */
export function normalizedTitleKey(title: string, refPattern = DEFAULT_SHORTCUT_REF): string {
  let s = stripRefs(title.toLowerCase(), refPattern);
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  s = stripRefs(s, refPattern.replace(/-/g, ' '));
  return s.replace(/\s+/g, ' ').trim();
}

// --- Constituent ordering (spec §1.3) -----------------------------------------

/** Ascending date order, undated last, `source_id` as the stable tie-break.
 * "Primary" = the first in this order. */
function sortConstituents(candidates: Entry[]): Entry[] {
  return [...candidates].sort((a, b) => {
    const da = dateOf(a);
    const db = dateOf(b);
    if (da !== db) {
      if (!da) return 1; // undated last
      if (!db) return -1;
      return da.localeCompare(db);
    }
    return sourceIdOf(a).localeCompare(sourceIdOf(b));
  });
}

// --- Body-fact extraction (all from our own staged bodies) --------------------

/** First 7 chars for a 40-hex-char SHA, else the full id (issue/PR databaseIds
 * are short already). */
function shortSourceId(sourceId: string): string {
  return /^[0-9a-f]{40}$/i.test(sourceId) ? sourceId.slice(0, 7) : sourceId;
}

interface ChangeSize {
  additions: number;
  deletions: number;
  changed_files: number;
}

function changeSizeOf(c: Entry): ChangeSize | null {
  const cs = c.frontmatter.change_size;
  if (typeof cs !== 'object' || cs === null) return null;
  const rec = cs as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    additions: num(rec.additions),
    deletions: num(rec.deletions),
    changed_files: num(rec.changed_files)
  };
}

/** The repo asserted by the constituent's own body header line
 * (`GitHub commit in {repo}.` / `GitHub PR in {repo}.`), or ''. */
function repoOf(c: Entry): string {
  const m = /^GitHub (?:commit|PR|Issue) in (.+?)\.$/m.exec(c.body ?? '');
  return m ? m[1] : '';
}

const isCommit = (c: Entry): boolean => /^GitHub commit in /m.test(c.body ?? '');

/** The constituent's verbatim message/description text: everything after the
 * first `--- Message ---` / `--- Description ---` delimiter, with any
 * `--- Shortcut ---` block stripped first so no Shortcut text leaks into a
 * "message" (spec §1.3 step 3). Trimmed; '' when absent or empty. */
function messageOf(c: Entry): string {
  const base = stripShortcutBlock(c.body ?? '');
  const m = /^--- (?:Message|Description) ---$/m.exec(base);
  if (!m) return '';
  return base.slice(m.index + m[0].length).trim();
}

/** The constituent's `--- Shortcut ---` block, verbatim (it is always last in
 * a staged body), or ''. */
function shortcutBlockOf(c: Entry): string {
  const body = c.body ?? '';
  const idx = body.indexOf(SHORTCUT_BLOCK);
  return idx < 0 ? '' : body.slice(idx).trimEnd();
}

/** `sc-{id}: {name}` parsed from the first constituent carrying a Shortcut
 * block whose header line matches our own `shortcutEnrichment` format, or ''.
 * Shared by {@link mergedTitleDefault} (precedence 1) and the inbox ticket
 * group labels (spec §5.1). */
export function shortcutStoryTitle(candidates: Entry[]): string {
  for (const c of sortConstituents(candidates)) {
    const block = shortcutBlockOf(c);
    if (!block) continue;
    const m = SHORTCUT_HEADER.exec(block.slice(SHORTCUT_BLOCK.length));
    if (m) return `sc-${m[1]}: ${m[2].trim()}`;
  }
  return '';
}

// --- The ledger (spec §1.3 step 2) --------------------------------------------

/**
 * One line per constituent, ascending date order:
 * `- {date or '—'} · {shortSourceId} · {title} · +{a} −{d}` — the `+a −d`
 * segment omitted when the constituent has no `change_size`. These are our own
 * computed facts (the commit-mapper idiom). Exported so the merge preview
 * dialog shows exactly what {@link buildMergedEntry} will assert.
 */
export function mergeLedger(candidates: Entry[]): string[] {
  return sortConstituents(candidates).map((c) => {
    const cs = changeSizeOf(c);
    const parts = [dateOf(c) || '—', shortSourceId(sourceIdOf(c)), titleOf(c)];
    if (cs) parts.push(`+${cs.additions} −${cs.deletions}`);
    return `- ${parts.join(' · ')}`;
  });
}

// --- Tag fold -------------------------------------------------------------------

/**
 * The merged entry's tags: every constituent's own tags in constituent order,
 * then the override tags, deduped (existing first — MergeOverrides.tags
 * semantics). Exported so the merge preview dialog shows exactly the tags
 * {@link buildMergedEntry} will apply.
 */
export function mergedTags(candidates: Entry[], overrideTags?: string[]): string[] {
  const tags: string[] = [];
  for (const c of sortConstituents(candidates)) {
    const t = Array.isArray(c.frontmatter.tags) ? c.frontmatter.tags : [];
    for (const tag of t) if (typeof tag === 'string' && !tags.includes(tag)) tags.push(tag);
  }
  for (const tag of overrideTags ?? []) {
    const t = tag.trim();
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

// --- Default title (spec §1.4) --------------------------------------------------

/**
 * The UI seed for `overrides.title`. Precedence: the Shortcut story name
 * (`sc-{id}: {name}`) when any constituent carries an enrichment block; else
 * the most frequent {@link normalizedTitleKey} among constituents, rendered
 * from the first constituent carrying it (original casing/wording, ticket ref
 * and all); else the primary's title.
 */
export function mergedTitleDefault(candidates: Entry[]): string {
  const fromStory = shortcutStoryTitle(candidates);
  if (fromStory) return fromStory;

  const ordered = sortConstituents(candidates);
  const byKey = new Map<string, { n: number; title: string }>();
  for (const c of ordered) {
    const key = normalizedTitleKey(titleOf(c));
    if (!key) continue;
    const seen = byKey.get(key);
    if (seen) seen.n++;
    else byKey.set(key, { n: 1, title: titleOf(c) });
  }
  let best: { n: number; title: string } | undefined;
  for (const v of byKey.values()) {
    if (!best || v.n > best.n) best = v; // insertion order breaks ties (first-seen)
  }
  if (best) return best.title;
  return titleOf(ordered[0]);
}

// --- The merged entry (spec §1.3) -----------------------------------------------

/**
 * Collapse validated candidates + the human's gate overrides into the
 * fully-formed merged entry (fresh ULID via `makeEntry`; the merged entry is a
 * new artifact — no constituent's stage-time ULID survives). Pure; all
 * validation throws happen before any construction, so the impure shell can
 * call it before touching the filesystem.
 */
export function buildMergedEntry(candidates: Entry[], overrides: MergeOverrides): Entry {
  // --- Validation (throw before any construction) ---------------------------
  if (candidates.length < 2) {
    throw new Error('Merging needs at least 2 candidates.');
  }
  const source = candidates[0].frontmatter.source;
  for (const c of candidates) {
    // This release: GitHub only; written so relaxing later is one line (D4).
    if (c.frontmatter.source !== source || source !== 'github') {
      throw new Error('Only same-source GitHub candidates can be merged.');
    }
    if (!sourceIdOf(c)) {
      throw new Error('Every merged candidate needs a non-empty source_id.');
    }
  }
  const title = overrides.title.trim();
  if (!title) throw new Error('The merged entry needs a title.');

  const ordered = sortConstituents(candidates);
  const primary = ordered[0];

  // --- Date gate (mirrors promoteCandidate — NEVER defaults to today) -------
  let date = '';
  if (overrides.date !== undefined) {
    const d = overrides.date.trim();
    if (d && !ISO_DATE.test(d)) throw new Error(`Invalid date "${d}" — use YYYY-MM-DD`);
    date = d;
  }
  if (!date) {
    date = ordered
      .map(dateOf)
      .filter(Boolean)
      .reduce((a, b) => (b > a ? b : a), '');
  }
  if (!date) {
    throw new Error('No constituent has a date yet — set a date before merging.');
  }

  // --- Frontmatter folds ------------------------------------------------------
  const tags = mergedTags(ordered, overrides.tags);

  const sourceIds = ordered.map(sourceIdOf);
  const links: string[] = [];
  for (const c of ordered) {
    const url = c.frontmatter.source_url;
    if (typeof url === 'string' && url && !links.includes(url)) links.push(url);
  }

  let project: string | undefined;
  if (overrides.project !== undefined) {
    project = overrides.project.trim() || undefined;
  } else {
    // The constituents' shared suggestion, kept only when all agree.
    const suggestions = ordered.map((c) =>
      typeof c.frontmatter.project === 'string' ? c.frontmatter.project : ''
    );
    project =
      suggestions[0] && suggestions.every((s) => s === suggestions[0]) ? suggestions[0] : undefined;
  }
  const parent = overrides.parent?.trim() || undefined;

  const shortcutIds: string[] = [];
  for (const c of ordered) {
    const ids = c.frontmatter.shortcut_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string' && id && !shortcutIds.includes(id)) shortcutIds.push(id);
  }
  const shortcut = ordered
    .map((c) => c.frontmatter.shortcut)
    .find((sc) => sc && typeof sc === 'object' && !Array.isArray(sc));

  const sizes = ordered.map(changeSizeOf).filter((cs): cs is ChangeSize => cs !== null);
  const changeSize =
    sizes.length > 0
      ? sizes.reduce(
          (sum, cs) => ({
            additions: sum.additions + cs.additions,
            deletions: sum.deletions + cs.deletions,
            changed_files: sum.changed_files + cs.changed_files
          }),
          { additions: 0, deletions: 0, changed_files: 0 }
        )
      : undefined;

  // Nothing else is carried: per-constituent facts (merged_at, commit_sha)
  // live in the body ledger; triage keys never reach the record (same stance
  // as promoteCandidate); the date gate above guarantees no needs_date.
  const extra: Record<string, unknown> = {
    reviewed: true,
    source: 'github',
    source_id: primary.frontmatter.source_id, // D2 scalar — primary constituent
    source_ids: sourceIds, // D2 array — the full set, primary included
    ...(typeof primary.frontmatter.source_url === 'string' && primary.frontmatter.source_url
      ? { source_url: primary.frontmatter.source_url }
      : {}),
    ...(links.length ? { links } : {}),
    ...(project ? { project } : {}),
    ...(parent ? { parent } : {}),
    ...(shortcutIds.length ? { shortcut_ids: shortcutIds } : {}),
    ...(shortcut ? { shortcut } : {}),
    ...(changeSize ? { change_size: changeSize } : {}),
    merged_count: candidates.length
  };
  for (const k of TRIAGE_KEYS) delete extra[k]; // belt & suspenders — never carried

  return makeEntry({
    type: 'journal',
    title,
    date,
    private: ordered.some((c) => c.frontmatter.private === true), // most-protective fold
    tags,
    body: mergedBody(ordered, candidates.length),
    extra
  });
}

/** Assemble the merged body (spec §1.3 steps 1–4): header line, ledger,
 * deduplicated verbatim message blocks (D5), then at most ONE Shortcut block,
 * always last — preserving the `stripShortcutBlock` invariant. */
function mergedBody(ordered: Entry[], count: number): string {
  // 1. Header line.
  const commits = ordered.filter(isCommit).length;
  const kind = commits === ordered.length ? 'commits' : commits === 0 ? 'PRs/issues' : 'items';
  const repos = [...new Set(ordered.map(repoOf).filter(Boolean))];
  const where =
    repos.length === 1 && ordered.every((c) => repoOf(c))
      ? ` in ${repos[0]}`
      : repos.length > 1
        ? ` across ${repos.length} repos`
        : '';
  const sections: string[] = [`Merged from ${count} GitHub ${kind}${where}.`];

  // 2. The ledger.
  sections.push(mergeLedger(ordered).join('\n'));

  // 3. Deduplicated messages (D5): byte-identical (after trim) bodies collapse
  //    to a single block listing the short ids that carried it; empty bodies
  //    are omitted entirely. First-seen constituent order.
  const carriers = new Map<string, string[]>();
  for (const c of ordered) {
    const text = messageOf(c);
    if (!text) continue;
    const ids = carriers.get(text);
    if (ids) ids.push(shortSourceId(sourceIdOf(c)));
    else carriers.set(text, [shortSourceId(sourceIdOf(c))]);
  }
  for (const [text, ids] of carriers) {
    sections.push(`--- Message (${ids.join(', ')}) ---\n${text}`);
  }

  // 4. One Shortcut block — the first constituent's, verbatim (all are built by
  //    shortcutEnrichment from the same story, so any is representative).
  const block = ordered.map(shortcutBlockOf).find(Boolean);
  if (block) sections.push(block);

  return sections.join('\n\n');
}
