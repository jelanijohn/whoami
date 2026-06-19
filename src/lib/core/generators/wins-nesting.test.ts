import { describe, it, expect } from 'vitest';
import { partitionWins } from './shared';
import { generateResumeMarkdown } from './resume';
import { generateSiteHtml } from './site';
import { emptyProfile } from '../profile';
import type { Entry, EntryFrontmatter } from '../types';

function entry(fm: Partial<EntryFrontmatter> & { id: string; type: string }, body = ''): Entry {
  return {
    frontmatter: { date: '2024-01-01', title: fm.id, private: false, ...fm },
    body
  };
}

const ROLE = entry({ id: 'ROLE1', type: 'role', title: 'Engineer' });
const PROJECT = entry({ id: 'PROJ1', type: 'project', title: 'Importer', slug: 'importer' });
const PRIVATE_ROLE = entry({ id: 'ROLE2', type: 'role', title: 'Secret', private: true });

describe('partitionWins (spec §4.1)', () => {
  const win = (id: string, parent?: string, priv = false) =>
    entry({ id, type: 'win', parent, private: priv });

  it('nests a win whose parent is a present public entry', () => {
    const { byParent, nestedIds } = partitionWins([ROLE, win('W1', 'ROLE1')]);
    expect(byParent.get('ROLE1')?.map((w) => w.frontmatter.id)).toEqual(['W1']);
    expect(nestedIds.has('W1')).toBe(true);
  });

  it('treats a win with a missing/absent parent as an orphan', () => {
    const { byParent, nestedIds } = partitionWins([ROLE, win('W1'), win('W2', 'NOPE')]);
    expect(byParent.size).toBe(0);
    expect(nestedIds.size).toBe(0);
  });

  it('treats a win whose parent is not in the set (e.g. private, stripped) as orphan', () => {
    // publicEntries would have dropped PRIVATE_ROLE before partition runs.
    const { nestedIds } = partitionWins([ROLE, win('W1', 'ROLE2')]);
    expect(nestedIds.has('W1')).toBe(false);
  });

  it('ignores non-win entries', () => {
    const { nestedIds } = partitionWins([ROLE, PROJECT]);
    expect(nestedIds.size).toBe(0);
  });
});

const profile = emptyProfile();

describe('résumé win nesting (spec §4.2)', () => {
  it('renders a nested win as a bullet under its role', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Shipped the thing', parent: 'ROLE1' });
    const md = generateResumeMarkdown({ profile, entries: [ROLE, win] });
    expect(md).toMatch(/### Engineer[\s\S]*- Shipped the thing/);
    // No "Highlights" heading when every win is nested.
    expect(md).not.toContain('## Highlights');
  });

  it('renders orphan wins as a bullet list under Highlights', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Did a thing' });
    const md = generateResumeMarkdown({ profile, entries: [win] });
    expect(md).toContain('## Highlights');
    expect(md).toContain('- Did a thing');
    expect(md).not.toContain('### Did a thing'); // a win is a bullet, never a heading
  });

  it('omits a private win everywhere', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Hidden', parent: 'ROLE1', private: true });
    const md = generateResumeMarkdown({ profile, entries: [ROLE, win] });
    expect(md).not.toContain('Hidden');
    expect(md).not.toContain('## Highlights');
  });
});

describe('site win nesting (spec §4.3)', () => {
  it('nests a win under its project article as ul.wins', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Cut latency', parent: 'PROJ1' });
    const html = generateSiteHtml({ profile, entries: [PROJECT, win] });
    expect(html).toMatch(/Importer[\s\S]*<ul class="wins">[\s\S]*Cut latency/);
  });

  it('renders orphan wins under Highlights as ul.wins', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Did a thing' });
    const html = generateSiteHtml({ profile, entries: [win] });
    expect(html).toContain('Highlights');
    expect(html).toMatch(/<ul class="wins">[\s\S]*Did a thing/);
  });

  it('drops a private win', () => {
    const win = entry({ id: 'W1', type: 'win', title: 'Hidden', private: true });
    const html = generateSiteHtml({ profile, entries: [win] });
    expect(html).not.toContain('Hidden');
  });
});
