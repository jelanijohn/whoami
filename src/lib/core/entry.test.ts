import { describe, expect, it } from 'vitest';
import {
  makeEntry,
  serializeEntry,
  parseEntry,
  touchEntry,
  expectedPath,
  entryErrors
} from './entry';
import { entryFilename, id6, isUlid, newId, slugify } from './ids';

describe('ids', () => {
  it('generates valid, unique ULIDs', () => {
    const a = newId();
    const b = newId();
    expect(isUlid(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('id6 is the last 6 chars, lowercased', () => {
    expect(id6('01HXYZP3K7QWERTY8N7G8H9JKM')).toBe('8h9jkm');
    expect(id6('ABCDEF123456')).toBe('123456');
  });

  it('slugify produces clean kebab-case', () => {
    expect(slugify('Shipped the X Dashboard!')).toBe('shipped-the-x-dashboard');
    expect(slugify('  café & crème  ')).toBe('cafe-creme');
    expect(slugify('---')).toBe('entry');
  });

  it('entryFilename follows {date}-{slug}-{id6}.md', () => {
    const name = entryFilename('2024-03-14', 'Shipped X', 'ABCDEF123456');
    expect(name).toBe('2024-03-14-shipped-x-123456.md');
  });
});

describe('makeEntry', () => {
  it('mints an entry with id, timestamps, date, and path', () => {
    const e = makeEntry({ type: 'win', title: 'Big Win' }, '2024-05-01T10:00:00Z');
    expect(isUlid(e.frontmatter.id)).toBe(true);
    expect(e.frontmatter.type).toBe('win');
    expect(e.frontmatter.date).toBe('2024-05-01');
    expect(e.frontmatter.created).toBe('2024-05-01T10:00:00Z');
    expect(e.frontmatter.updated).toBe('2024-05-01T10:00:00Z');
    expect(e.frontmatter.private).toBe(false);
    expect(e.path).toMatch(/^entries\/2024-05-01-big-win-[0-9a-z]{6}\.md$/);
  });

  it('carries extra type-specific fields into frontmatter', () => {
    const e = makeEntry({
      type: 'role',
      title: 'SWE',
      extra: { org: 'Bloomberg', role: 'Software Engineer' }
    });
    expect(e.frontmatter.org).toBe('Bloomberg');
    expect(e.frontmatter.role).toBe('Software Engineer');
  });
});

describe('touchEntry', () => {
  it('updates only `updated`, leaves created and id', () => {
    const e = makeEntry({ type: 'journal', title: 't' }, '2024-01-01T00:00:00Z');
    const t = touchEntry(e, '2024-02-02T00:00:00Z');
    expect(t.frontmatter.updated).toBe('2024-02-02T00:00:00Z');
    expect(t.frontmatter.created).toBe('2024-01-01T00:00:00Z');
    expect(t.frontmatter.id).toBe(e.frontmatter.id);
  });
});

describe('expectedPath', () => {
  it('changes when title or date changes (id6 stays)', () => {
    const e = makeEntry({ type: 'journal', title: 'Old', date: '2024-01-01' });
    const renamed = { ...e, frontmatter: { ...e.frontmatter, title: 'New Name' } };
    expect(expectedPath(renamed)).toContain('new-name');
    expect(expectedPath(renamed)).toContain(id6(e.frontmatter.id));
  });
});

describe('entryErrors', () => {
  it('flags missing required fields', () => {
    const bad = parseEntry(`---\ntype: journal\n---\n`);
    const errs = entryErrors(bad);
    expect(errs.some((e) => e.includes('id'))).toBe(true);
    expect(errs.some((e) => e.includes('date'))).toBe(true);
    expect(errs.some((e) => e.includes('title'))).toBe(true);
  });

  it('accepts a well-formed entry', () => {
    const e = makeEntry({ type: 'role', title: 'ok' });
    expect(entryErrors(e)).toEqual([]);
  });
});

describe('serialize is idempotent', () => {
  it('serialize→parse→serialize is stable', () => {
    const e = makeEntry({ type: 'project', title: 'Thing', body: 'notes', tags: ['a', 'b'] });
    const once = serializeEntry(e);
    const twice = serializeEntry(parseEntry(once));
    expect(twice).toBe(once);
  });
});
