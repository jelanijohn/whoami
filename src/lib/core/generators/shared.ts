/**
 * Shared helpers for the output generators (resume, site).
 *
 * The privacy rule (spec §7) is enforced here, once: `private: true` entries
 * MUST NOT appear in any generated artifact, in any field, ever — including
 * derived/aggregate views. Every generator funnels its input through
 * {@link publicEntries} so the exclusion can never be forgotten downstream.
 */

import type { Entry } from '../types';

/** Drop every private entry. The single chokepoint for the §7 guarantee. */
export function publicEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.frontmatter.private !== true);
}

/** Group entries by their `type`, preserving input order within each group. */
export function groupByType(entries: Entry[]): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = groups.get(e.frontmatter.type) ?? [];
    list.push(e);
    groups.set(e.frontmatter.type, list);
  }
  return groups;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/** Format an ISO date (YYYY-MM-DD) as e.g. "Mar 2024". Falls back to the raw
 * string if it isn't a recognizable date. */
export function monthYear(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = MONTHS[parseInt(m[2], 10) - 1] ?? '';
  return month ? `${month} ${m[1]}` : m[1];
}

/** A string field from frontmatter, or '' if absent/non-string. */
export function str(entry: Entry, key: string): string {
  const v = entry.frontmatter[key];
  return typeof v === 'string' ? v : '';
}

/** Links array from frontmatter, tolerating string-or-array shapes. */
export function links(entry: Entry): string[] {
  const v = entry.frontmatter.links;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
