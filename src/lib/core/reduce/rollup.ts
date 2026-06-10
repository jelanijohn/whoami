/**
 * Deterministic project rollup (ingest-reduce plan §4.2).
 *
 * A pure function over a project's gathered entries — no LLM, always available.
 * It is the floor of Stage 2: useful in the project view header even with no
 * provider configured, and embedded as compact context in the reduce prompts
 * (waid's `summarize` equivalent).
 */

import type { Entry } from '../types';

export interface RollupGap {
  /** Date of the entry before the gap (YYYY-MM-DD). */
  from: string;
  /** Date of the entry after the gap (YYYY-MM-DD). */
  to: string;
  /** Whole weeks between them. */
  weeks: number;
}

export interface ProjectRollup {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  /** Earliest/latest event date across the entries, or null if none have one. */
  dateRange: { start: string; end: string } | null;
  /** Stretches longer than `gapWeeks` with no entries (chronological order). */
  gaps: RollupGap[];
  /** Tags by descending use, capped at `topTagsLimit`. */
  topTags: { tag: string; count: number }[];
  /** How many of the entries are `private: true`. */
  private: number;
}

export interface RollupOptions {
  /** Report gaps strictly longer than this many weeks. Default 4. */
  gapWeeks?: number;
  /** Cap on the top-tags list. Default 10. */
  topTagsLimit?: number;
}

/** Days since the Unix epoch for a YYYY-MM-DD prefix, or null. UTC-based so the
 * result never depends on the host timezone. */
function toEpochDays(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function rollupEntries(entries: Entry[], opts: RollupOptions = {}): ProjectRollup {
  const gapWeeks = opts.gapWeeks ?? 4;
  const topTagsLimit = opts.topTagsLimit ?? 10;

  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  const dated: { date: string; days: number }[] = [];
  let priv = 0;

  for (const { frontmatter: fm } of entries) {
    const type = typeof fm.type === 'string' ? fm.type : 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;

    if (typeof fm.source === 'string' && fm.source) {
      bySource[fm.source] = (bySource[fm.source] ?? 0) + 1;
    }
    if (fm.private === true) priv++;

    if (Array.isArray(fm.tags)) {
      for (const tag of fm.tags) {
        if (typeof tag === 'string' && tag) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    if (typeof fm.date === 'string') {
      const days = toEpochDays(fm.date);
      if (days !== null) dated.push({ date: fm.date.slice(0, 10), days });
    }
  }

  dated.sort((a, b) => a.days - b.days);

  const dateRange =
    dated.length > 0 ? { start: dated[0].date, end: dated[dated.length - 1].date } : null;

  const gaps: RollupGap[] = [];
  for (let i = 1; i < dated.length; i++) {
    const weeks = Math.floor((dated[i].days - dated[i - 1].days) / 7);
    if (weeks > gapWeeks) {
      gaps.push({ from: dated[i - 1].date, to: dated[i].date, weeks });
    }
  }

  const topTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, topTagsLimit);

  return { total: entries.length, byType, bySource, dateRange, gaps, topTags, private: priv };
}

/** A compact one-block text summary — for the reduce prompts' context and as a
 * fallback render. Pure and easy to snapshot-test. */
export function rollupSummary(r: ProjectRollup): string {
  const lines: string[] = [];
  lines.push(
    `${r.total} ${r.total === 1 ? 'entry' : 'entries'}` +
      (r.dateRange ? ` from ${r.dateRange.start} to ${r.dateRange.end}` : '') +
      (r.private ? ` (${r.private} private)` : '')
  );
  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  if (Object.keys(r.byType).length) lines.push(`By type: ${fmt(r.byType)}`);
  if (Object.keys(r.bySource).length) lines.push(`By source: ${fmt(r.bySource)}`);
  if (r.topTags.length) lines.push(`Top tags: ${r.topTags.map((t) => `${t.tag} (${t.count})`).join(', ')}`);
  if (r.gaps.length) {
    lines.push(`Gaps: ${r.gaps.map((g) => `${g.from}→${g.to} (${g.weeks}w)`).join(', ')}`);
  }
  return lines.join('\n');
}
