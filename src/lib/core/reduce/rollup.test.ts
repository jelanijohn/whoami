import { describe, it, expect } from 'vitest';
import { rollupEntries, rollupSummary } from './rollup';
import type { Entry, EntryFrontmatter } from '../types';

function entry(fm: Partial<EntryFrontmatter> & { date: string; type: string }): Entry {
  return {
    frontmatter: { id: 'x', title: 't', private: false, ...fm },
    body: ''
  };
}

describe('rollupEntries (plan §4.2)', () => {
  it('counts by type and by source, and tallies private entries', () => {
    const r = rollupEntries([
      entry({ type: 'win', date: '2024-01-01', source: 'github' }),
      entry({ type: 'win', date: '2024-01-08', source: 'github' }),
      entry({ type: 'journal', date: '2024-01-09' }),
      entry({ type: 'journal', date: '2024-01-10', private: true, source: 'gmail' })
    ]);
    expect(r.total).toBe(4);
    expect(r.byType).toEqual({ win: 2, journal: 2 });
    expect(r.bySource).toEqual({ github: 2, gmail: 1 });
    expect(r.private).toBe(1);
  });

  it('computes the date range from the earliest and latest entries', () => {
    const r = rollupEntries([
      entry({ type: 'journal', date: '2024-03-15' }),
      entry({ type: 'journal', date: '2024-01-02' }),
      entry({ type: 'journal', date: '2024-02-20' })
    ]);
    expect(r.dateRange).toEqual({ start: '2024-01-02', end: '2024-03-15' });
  });

  it('reports gaps longer than the threshold, in chronological order', () => {
    const r = rollupEntries(
      [
        entry({ type: 'journal', date: '2024-01-01' }),
        entry({ type: 'journal', date: '2024-01-08' }), // 1 week — no gap
        entry({ type: 'journal', date: '2024-03-01' }) // ~7.5 weeks — gap
      ],
      { gapWeeks: 4 }
    );
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ from: '2024-01-08', to: '2024-03-01' });
    expect(r.gaps[0].weeks).toBeGreaterThan(4);
  });

  it('ranks tags by descending use, capped at the limit', () => {
    const r = rollupEntries(
      [
        entry({ type: 'journal', date: '2024-01-01', tags: ['a', 'b'] }),
        entry({ type: 'journal', date: '2024-01-02', tags: ['a', 'c'] }),
        entry({ type: 'journal', date: '2024-01-03', tags: ['a'] })
      ],
      { topTagsLimit: 2 }
    );
    expect(r.topTags).toEqual([
      { tag: 'a', count: 3 },
      { tag: 'b', count: 1 }
    ]);
  });

  it('handles an empty set without inventing a range', () => {
    const r = rollupEntries([]);
    expect(r).toMatchObject({ total: 0, dateRange: null, gaps: [], topTags: [] });
  });

  it('rollupSummary renders a compact, deterministic block', () => {
    const r = rollupEntries([
      entry({ type: 'win', date: '2024-01-01', source: 'github', tags: ['ship'] }),
      entry({ type: 'journal', date: '2024-03-01', private: true })
    ]);
    const text = rollupSummary(r);
    expect(text).toContain('2 entries from 2024-01-01 to 2024-03-01 (1 private)');
    expect(text).toContain('By type: ');
    expect(text).toContain('By source: github 1');
    expect(text).toContain('ship (1)');
  });
});
