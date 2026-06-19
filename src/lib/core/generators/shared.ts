/**
 * Shared helpers for the output generators (resume, site).
 *
 * The privacy rule (spec §7) is enforced here, once: `private: true` entries
 * MUST NOT appear in any generated artifact, in any field, ever — including
 * derived/aggregate views. Every generator funnels its input through
 * {@link publicEntries} so the exclusion can never be forgotten downstream.
 */

import type { Entry } from '../types';
import { stripMarkedBlock } from '../reduce/markers';

/**
 * Drop every private entry, and strip every `whoami:reduce` region from the
 * bodies that remain (ingest-reduce plan §4.5). The single chokepoint for both
 * the §7 privacy guarantee and the rule that derived reductions never leak into
 * outward artifacts — the reduction is a dashboard/self-knowledge artifact, not
 * resume/site content.
 */
export function publicEntries(entries: Entry[]): Entry[] {
  return entries
    .filter((e) => e.frontmatter.private !== true)
    .map((e) => ({ ...e, body: stripMarkedBlock(e.body) }));
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

/**
 * Partition wins by their resolvable parent (wins-from-journal spec §4.1).
 *
 * Operates on the already-public set, so a win whose `parent` is private/missing
 * simply has no resolvable parent and falls through to the flat "Highlights"
 * section. A win (`type: 'win'`) with a string `parent` matching a present entry
 * id goes into `byParent`; input order is preserved within each bucket.
 */
export function partitionWins(entries: Entry[]): {
  byParent: Map<string, Entry[]>;
  nestedIds: Set<string>;
} {
  const present = new Set(entries.map((e) => String(e.frontmatter.id)));
  const byParent = new Map<string, Entry[]>();
  const nestedIds = new Set<string>();
  for (const e of entries) {
    if (e.frontmatter.type !== 'win') continue;
    const parent = e.frontmatter.parent;
    if (typeof parent !== 'string' || !present.has(parent)) continue;
    const list = byParent.get(parent) ?? [];
    list.push(e);
    byParent.set(parent, list);
    nestedIds.add(String(e.frontmatter.id));
  }
  return { byParent, nestedIds };
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
