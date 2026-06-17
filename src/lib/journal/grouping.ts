/**
 * Pure grouping + date helpers for the Journal views (design handoff).
 *
 * These operate over the already filtered+sorted entry list returned by the
 * index query (see the architecture note in the handoff): the query does the
 * heavy lifting, and grouping for the Grouped / Timeline / Calendar views is a
 * cheap client-side pass over that page.
 */

import type { Entry } from '$lib/core';
import type { SortDir } from '$lib/core';
import { typeMeta, typeOrder } from './theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const RSQUO = '’'; // ’
const ENDASH = '–'; // –

/** "Mar 5 ’25" — the dense single-line date. */
export function fmtShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d} ${RSQUO}${String(y).slice(2)}`;
}

/** "Mon, Mar 5, 2025" — the full weekday date for headers + meta lines. */
export function fmtDay(iso: string): string {
  const dt = new Date(iso + 'T00:00:00Z');
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "March 2025" from a "YYYY-MM" key. */
export function monthYear(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_FULL[m - 1]} ${y}`;
}

/** "Mar ’25" from a "YYYY-MM" key — the heatmap "most active month" stat. */
export function monthShortYear(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${RSQUO}${String(y).slice(2)}`;
}

/** "Mar 5 ’25 – Apr 2 ’25" (or a single date) spanning a group's entries. */
export function dateRange(entries: Entry[]): string {
  if (!entries.length) return '';
  let mn = String(entries[0].frontmatter.date);
  let mx = mn;
  for (const e of entries) {
    const d = String(e.frontmatter.date);
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  return mn === mx ? fmtShort(mn) : `${fmtShort(mn)} ${ENDASH} ${fmtShort(mx)}`;
}

export type GroupBy = 'project' | 'type' | 'month';

export interface JournalGroup {
  key: string;
  label: string;
  /** A `var(--*)` color for the group's swatch. */
  color: string;
  entries: Entry[];
}

export interface GroupContext {
  /** Resolve a project slug to its display title. */
  projectTitle: (slug: string) => string;
  /** Resolve a project slug to its section color (`var(--jv-proj-*)`). */
  projectColor: (slug: string) => string;
  /** Active sort direction — Month groups follow it. */
  sortDir: SortDir;
}

const proj = (e: Entry): string =>
  typeof e.frontmatter.project === 'string' ? e.frontmatter.project : '';

/**
 * Bucket the (pre-sorted) entries into collapsible groups. Group ordering:
 * Project by entry count desc, Type by canonical order, Month by date honoring
 * the sort direction. Entries inside a group keep the incoming query order.
 */
export function computeGroups(entries: Entry[], groupBy: GroupBy, ctx: GroupContext): JournalGroup[] {
  const map = new Map<string, JournalGroup>();
  for (const e of entries) {
    let key: string, label: string, color: string;
    if (groupBy === 'project') {
      const slug = proj(e);
      key = slug || '__none';
      label = slug ? ctx.projectTitle(slug) : 'Unaffiliated';
      color = ctx.projectColor(slug);
    } else if (groupBy === 'type') {
      const type = String(e.frontmatter.type);
      key = type;
      label = typeMeta(type).label;
      color = typeMeta(type).color;
    } else {
      key = String(e.frontmatter.date).slice(0, 7);
      label = monthYear(key);
      color = 'var(--color-accent)';
    }
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label, color, entries: [] }));
    g.entries.push(e);
  }
  const groups = [...map.values()];
  if (groupBy === 'type') {
    groups.sort((a, b) => typeOrder(a.key) - typeOrder(b.key));
  } else if (groupBy === 'month') {
    const sign = ctx.sortDir === 'asc' ? 1 : -1;
    groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * sign);
  } else {
    groups.sort((a, b) => b.entries.length - a.entries.length);
  }
  return groups;
}

export interface DayGroup {
  /** YYYY-MM-DD. */
  key: string;
  label: string;
  entries: Entry[];
}

/** Group the (pre-sorted) entries by calendar day, preserving incoming order —
 * the Timeline view's day rail. */
export function dayGroups(entries: Entry[]): DayGroup[] {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const date = String(e.frontmatter.date);
    let list = map.get(date);
    if (!list) map.set(date, (list = []));
    list.push(e);
  }
  return [...map.entries()].map(([key, list]) => ({ key, label: fmtDay(key), entries: list }));
}
