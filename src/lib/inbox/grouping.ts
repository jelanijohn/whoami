/**
 * Pure filter / sort / group helpers for the Inbox (ingest triage) redesign.
 *
 * Unlike the Journal (server-side query), the inbox is loaded in full into
 * `app.candidates`, so every facet here is a cheap client-side pass over that
 * in-memory list. Keeping the logic pure (data in → data out) mirrors the
 * ingest mappers and keeps it trivially testable off-device.
 */

import type { Entry } from '$lib/core';
import { normalizedTitleKey, shortcutStoryTitle, ticketOf } from '$lib/core';
import { typeMeta, typeOrder, sourceMeta, sourceOrder, KEPT_COLOR, FLAGGED_COLOR } from './theme';

// The ticket-grouping accessors live in the pure core (merge spec §1.1–1.2, so
// they're vitest-covered off-device); re-exported here alongside their
// siblings so the inbox keeps one import surface for field accessors.
export { normalizedTitleKey, ticketOf };

// --- Field accessors (read-tolerant, matching the old CandidateCard) --------

export const titleOf = (c: Entry): string =>
  typeof c.frontmatter.title === 'string' ? c.frontmatter.title : '';
export const typeOf = (c: Entry): string => String(c.frontmatter.type ?? '');
export const sourceOf = (c: Entry): string =>
  typeof c.frontmatter.source === 'string' ? c.frontmatter.source : '';
export const projectOf = (c: Entry): string =>
  typeof c.frontmatter.project === 'string' ? c.frontmatter.project : '';
/** Shortcut project name (story import + enriched GitHub items both carry
 * `shortcut.project` when the workspace uses Projects). */
export const shortcutProjectOf = (c: Entry): string => {
  const sc = c.frontmatter.shortcut;
  const p = sc && typeof sc === 'object' ? (sc as Record<string, unknown>).project : undefined;
  return typeof p === 'string' ? p : '';
};
export const dateOf = (c: Entry): string => String(c.frontmatter.date ?? '');
export const isFrivolous = (c: Entry): boolean => c.frontmatter.triage_signal === 'frivolous';
export const tagsOf = (c: Entry): string[] =>
  Array.isArray(c.frontmatter.tags) ? (c.frontmatter.tags as unknown[]).map(String) : [];

export interface ChangeSize {
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** Parse the optional `change_size` pass-through (GitHub PRs). Null ⇒ no badge. */
export function changeSizeOf(c: Entry): ChangeSize | null {
  const cs = c.frontmatter.change_size;
  if (typeof cs !== 'object' || cs === null) return null;
  const rec = cs as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    additions: num(rec.additions),
    deletions: num(rec.deletions),
    changedFiles: num(rec.changed_files)
  };
}

const totalChanges = (c: Entry): number => {
  const cs = changeSizeOf(c);
  return cs ? cs.additions + cs.deletions : 0;
};

// --- Relative date ----------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3d ago" for recent dates, then "Jun 2" (adding "’24" across years). The
 * `now` epoch is injected so the function stays pure/testable. */
export function relativeDate(iso: string, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(t)) return iso;
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days < 7) return `${days}d ago`;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const label = `${MONTHS[(m || 1) - 1]} ${d}`;
  const thisYear = new Date(now).getFullYear();
  return y === thisYear ? label : `${label} ’${String(y).slice(2)}`;
}

// --- Filtering --------------------------------------------------------------

export type FrivolousMode = 'all' | 'kept' | 'flagged';

export interface FilterOpts {
  search: string;
  selTypes: string[];
  selSources: string[];
  /** '' = all, '__none' = unaffiliated, else a project slug. */
  filterProject: string;
  frivolousMode: FrivolousMode;
}

export interface InboxContext {
  /** Resolve a project slug to its display title (for search + group labels). */
  projectTitle: (slug: string) => string;
}

/** True if any facet is narrowing the inbox (drives the "Clear filters" link). */
export function hasActiveFilters(o: FilterOpts): boolean {
  return (
    o.search.trim() !== '' ||
    o.selTypes.length > 0 ||
    o.selSources.length > 0 ||
    o.filterProject !== '' ||
    o.frivolousMode !== 'all'
  );
}

/** Client-side narrow over the in-memory inbox. Type/Source chips are OR within
 * a facet, AND across facets; status + project AND on top. Search matches title,
 * body, source, project title, Shortcut project name, and tags (case-insensitive). */
export function filterCandidates(list: Entry[], o: FilterOpts, ctx: InboxContext): Entry[] {
  const q = o.search.trim().toLowerCase();
  return list.filter((c) => {
    if (o.frivolousMode === 'kept' && isFrivolous(c)) return false;
    if (o.frivolousMode === 'flagged' && !isFrivolous(c)) return false;
    if (o.selTypes.length && !o.selTypes.includes(typeOf(c))) return false;
    if (o.selSources.length && !o.selSources.includes(sourceOf(c))) return false;
    if (o.filterProject === '__none') {
      if (projectOf(c)) return false;
    } else if (o.filterProject && projectOf(c) !== o.filterProject) {
      return false;
    }
    if (q) {
      const slug = projectOf(c);
      const hay = [
        titleOf(c),
        c.body,
        sourceOf(c),
        slug ? ctx.projectTitle(slug) : '',
        shortcutProjectOf(c),
        tagsOf(c).join(' ')
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// --- Sorting ----------------------------------------------------------------

export type SortKey = 'date' | 'title' | 'type' | 'source' | 'project' | 'size';
export type SortDir = 'asc' | 'desc';

/** Default direction when switching to a key: date & size lead newest/biggest. */
export function defaultDir(key: SortKey): SortDir {
  return key === 'date' || key === 'size' ? 'desc' : 'asc';
}

/** Stable sort over a copy. Secondary key is always date-desc for ties. */
export function sortCandidates(list: Entry[], key: SortKey, dir: SortDir): Entry[] {
  const sign = dir === 'asc' ? 1 : -1;
  const primary = (a: Entry, b: Entry): number => {
    switch (key) {
      case 'title':
        return titleOf(a).localeCompare(titleOf(b));
      case 'type':
        return typeOrder(typeOf(a)) - typeOrder(typeOf(b));
      case 'source':
        return sourceOrder(sourceOf(a)) - sourceOrder(sourceOf(b)) || sourceOf(a).localeCompare(sourceOf(b));
      case 'project':
        return projectOf(a).localeCompare(projectOf(b));
      case 'size':
        return totalChanges(a) - totalChanges(b);
      case 'date':
      default:
        return dateOf(a).localeCompare(dateOf(b));
    }
  };
  return [...list].sort((a, b) => {
    const p = primary(a, b) * sign;
    if (p !== 0) return p;
    return dateOf(b).localeCompare(dateOf(a)); // tie-break: newest first
  });
}

// --- Grouping ---------------------------------------------------------------

export type GroupBy = 'source' | 'type' | 'project' | 'ticket' | 'status' | 'none';

export interface GroupSwatch {
  /** 'tile' = rounded source tile with a glyph; 'square' = small color chip. */
  variant: 'tile' | 'square';
  color: string;
  glyph?: string;
}

export interface InboxGroup {
  key: string;
  label: string;
  swatch: GroupSwatch | null;
  candidates: Entry[];
  kept: number;
  flagged: number;
}

const ACCENT = 'var(--color-accent)';
const UNAFFILIATED = 'var(--jv-proj-none)';

/** Bucket the (already filtered + sorted) candidates into collapsible groups.
 * Flat list returns a single header-less group. */
export function computeGroups(list: Entry[], groupBy: GroupBy, ctx: InboxContext): InboxGroup[] {
  if (groupBy === 'none') {
    return [makeGroup('__all', '', null, list)];
  }

  const map = new Map<string, InboxGroup>();
  const push = (key: string, label: string, swatch: GroupSwatch | null, c: Entry) => {
    let g = map.get(key);
    if (!g) map.set(key, (g = makeGroup(key, label, swatch, [])));
    g.candidates.push(c);
  };

  // Ticket mode (merge spec §5.1): Shortcut ticket primary, normalized-title
  // fallback for ticketless candidates — but a title key only forms a group
  // when ≥ 2 candidates share it (computed in a pre-pass), and such groups are
  // visibly marked `· suggested` (the D1 heuristic marker). Everything else
  // lands in Ungrouped.
  const titleKeyCounts = new Map<string, number>();
  if (groupBy === 'ticket') {
    for (const c of list) {
      if (ticketOf(c)) continue;
      const k = normalizedTitleKey(titleOf(c));
      if (k) titleKeyCounts.set(k, (titleKeyCounts.get(k) ?? 0) + 1);
    }
  }
  const ticketSwatch: GroupSwatch = { variant: 'square', color: sourceMeta('shortcut').color };
  const neutralSwatch: GroupSwatch = { variant: 'square', color: UNAFFILIATED };

  for (const c of list) {
    if (groupBy === 'ticket') {
      const tid = ticketOf(c);
      if (tid) {
        push(`sc:${tid}`, `sc-${tid}`, ticketSwatch, c);
      } else {
        const k = normalizedTitleKey(titleOf(c));
        if (k && (titleKeyCounts.get(k) ?? 0) >= 2) {
          push(`t:${k}`, `${titleOf(c)} · suggested`, neutralSwatch, c);
        } else {
          push('__solo', 'Ungrouped', neutralSwatch, c);
        }
      }
    } else if (groupBy === 'source') {
      const src = sourceOf(c);
      const m = sourceMeta(src);
      push(src || 'unknown', m.label, { variant: 'tile', color: m.color, glyph: m.glyph }, c);
    } else if (groupBy === 'type') {
      const t = typeOf(c);
      const m = typeMeta(t);
      push(t, m.label, { variant: 'square', color: m.color }, c);
    } else if (groupBy === 'project') {
      const slug = projectOf(c);
      const key = slug || '__none';
      const label = slug ? ctx.projectTitle(slug) : 'Unaffiliated';
      push(key, label, { variant: 'square', color: slug ? ACCENT : UNAFFILIATED }, c);
    } else {
      // status
      const friv = isFrivolous(c);
      push(
        friv ? 'flagged' : 'kept',
        friv ? 'Flagged' : 'Kept',
        { variant: 'square', color: friv ? FLAGGED_COLOR : KEPT_COLOR },
        c
      );
    }
  }

  const groups = [...map.values()];
  groups.forEach(tallyGroup);

  if (groupBy === 'ticket') {
    // Ticket groups get the story name when any member's Shortcut block
    // yields one (the §1.4 header parse) — `sc-57886: <story name>`.
    for (const g of groups) {
      if (!g.key.startsWith('sc:')) continue;
      const named = shortcutStoryTitle(g.candidates);
      if (named) g.label = named;
    }
    // Size desc (the project-group idiom), Ungrouped pinned last.
    const solo = (g: InboxGroup) => (g.key === '__solo' ? 1 : 0);
    groups.sort((a, b) => solo(a) - solo(b) || b.candidates.length - a.candidates.length);
  } else if (groupBy === 'source') {
    groups.sort((a, b) => sourceOrder(a.key) - sourceOrder(b.key) || a.label.localeCompare(b.label));
  } else if (groupBy === 'type') {
    groups.sort((a, b) => typeOrder(a.key) - typeOrder(b.key));
  } else if (groupBy === 'status') {
    groups.sort((a, b) => (a.key === 'kept' ? -1 : 1) - (b.key === 'kept' ? -1 : 1));
  } else {
    groups.sort((a, b) => b.candidates.length - a.candidates.length);
  }
  return groups;
}

function makeGroup(key: string, label: string, swatch: GroupSwatch | null, candidates: Entry[]): InboxGroup {
  const g: InboxGroup = { key, label, swatch, candidates, kept: 0, flagged: 0 };
  if (candidates.length) tallyGroup(g);
  return g;
}

function tallyGroup(g: InboxGroup): void {
  g.flagged = g.candidates.filter(isFrivolous).length;
  g.kept = g.candidates.length - g.flagged;
}
