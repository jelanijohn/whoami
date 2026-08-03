import { describe, it, expect } from 'vitest';
import {
  REDUCE_START,
  upsertMarkedBlock,
  extractMarkedBlock,
  stripMarkedBlock,
  hasMarkedBlock
} from './markers';
import { chunkEntries, serializeEntryBlock } from './chunk';
import { buildAliasTable } from './alias';
import { buildMapPrompt, buildReducePrompt } from './prompts';
import { parseRetrospective, filterByEvidence } from './parse';
import { renderRetrospective } from './render';
import { emptyRetro } from './schema';
import { publicEntries } from '../generators/shared';
import { id6 } from '../ids';
import type { Entry, EntryFrontmatter } from '../types';

function entry(fm: Partial<EntryFrontmatter> & { id: string; date: string }, body = ''): Entry {
  return { frontmatter: { type: 'journal', title: 't', private: false, ...fm }, body };
}

describe('marker region (plan §4.4)', () => {
  it('appends a region once, preserving prose', () => {
    const out = upsertMarkedBlock('Human prose.', 'INNER');
    expect(out).toContain('Human prose.');
    expect(hasMarkedBlock(out)).toBe(true);
    expect(extractMarkedBlock(out)).toBe('INNER');
    expect(out.split(REDUCE_START).length - 1).toBe(1);
  });

  it('replaces the inner block in place (idempotent, single region)', () => {
    const once = upsertMarkedBlock('Prose.', 'FIRST');
    const twice = upsertMarkedBlock(once, 'SECOND');
    expect(twice.split(REDUCE_START).length - 1).toBe(1);
    expect(extractMarkedBlock(twice)).toBe('SECOND');
    expect(twice).toContain('Prose.');
    expect(twice).not.toContain('FIRST');
  });

  it('strips the region back out, leaving the prose', () => {
    const withBlock = upsertMarkedBlock('Just prose.', 'INNER');
    expect(stripMarkedBlock(withBlock).trim()).toBe('Just prose.');
    expect(stripMarkedBlock('no markers here')).toBe('no markers here');
  });
});

describe('chunking (plan §4.3)', () => {
  const es = [
    entry({ id: 'A', date: '2024-01-01' }, 'x'.repeat(400)),
    entry({ id: 'B', date: '2024-01-02' }, 'y'.repeat(400)),
    entry({ id: 'C', date: '2024-01-03' }, 'z'.repeat(400))
  ];

  it('puts everything in one chunk under a generous budget', () => {
    expect(chunkEntries(es, { tokenBudget: 100_000 })).toHaveLength(1);
  });

  it('splits when the budget is small, preserving order', () => {
    const chunks = chunkEntries(es, { tokenBudget: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((e) => e.frontmatter.id)).toEqual(['A', 'B', 'C']);
  });

  it('serializes an entry as an id/date/type/title/body block', () => {
    const block = serializeEntryBlock(entry({ id: 'A', date: '2024-01-01', type: 'win', title: 'Hi' }, 'body text'));
    expect(block).toContain('id: A');
    expect(block).toContain('type: win');
    expect(block).toContain('body: body text');
  });

  it('renders a displayId alias in place of the real id when given one', () => {
    const block = serializeEntryBlock(entry({ id: 'REALID', date: '2024-01-01' }), 'E3');
    expect(block).toContain('id: E3');
    expect(block).not.toContain('REALID');
  });
});

describe('alias-aware prompts (no ULIDs cross the LLM boundary)', () => {
  const ULID_RE = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/;
  const u1 = '01HX00000000000000000000A1';
  const u2 = '01HX00000000000000000000B2';
  const es = [entry({ id: u1, date: '2024-01-01' }, 'x'), entry({ id: u2, date: '2024-01-02' }, 'y')];
  const table = buildAliasTable([u1, u2]);

  it('the map prompt shows entries under their aliases, never ULIDs', () => {
    const { user } = buildMapPrompt(es, table);
    expect(user).toContain('id: E1');
    expect(user).toContain('id: E2');
    expect(user).not.toMatch(ULID_RE);
  });

  it('the reduce prompt re-aliases map-output evidence with the same table', () => {
    const retro = { ...emptyRetro(), worked_on: [{ text: 'did x', evidence: [u1, u2] }] };
    const { user } = buildReducePrompt([retro], '', '', table);
    expect(user).toContain('"E1"');
    expect(user).toContain('"E2"');
    expect(user).not.toMatch(ULID_RE);
  });
});

describe('strict parse + evidence filter (plan §4.3)', () => {
  it('strips a code fence and parses the closed shape', () => {
    const raw = '```json\n{"worked_on":[{"text":"did x","evidence":["A"]}],"successes":[],"failures":[],"lessons":[]}\n```';
    const retro = parseRetrospective(raw);
    expect(retro.worked_on).toHaveLength(1);
    expect(retro.worked_on[0]).toMatchObject({ text: 'did x', evidence: ['A'] });
  });

  it('throws on non-JSON (run fails visibly)', () => {
    expect(() => parseRetrospective('sorry, I cannot do that')).toThrow();
  });

  it('recovers JSON wrapped in a prose preamble/trailer', () => {
    const raw =
      'Here is the retrospective:\n' +
      '{"worked_on":[{"text":"did x","evidence":["A"]}],"successes":[],"failures":[],"lessons":[]}\n' +
      'Let me know if you need changes.';
    const retro = parseRetrospective(raw);
    expect(retro.worked_on).toMatchObject([{ text: 'did x', evidence: ['A'] }]);
  });

  it('flags a truncated reply (the large-project failure) in the error', () => {
    const truncated = '{"worked_on":[{"text":"did x","evidence":["A0000000000000000000000000';
    expect(() => parseRetrospective(truncated)).toThrow(/looks truncated/);
  });

  it('drops facts citing a ULID outside the input set, and facts with no evidence', () => {
    const retro = {
      ...emptyRetro(),
      worked_on: [
        { text: 'real', evidence: ['A'] },
        { text: 'foreign', evidence: ['A', 'GHOST'] },
        { text: 'unsupported', evidence: [] }
      ]
    };
    const filtered = filterByEvidence(retro, new Set(['A', 'B']));
    expect(filtered.worked_on.map((f) => f.text)).toEqual(['real']);
  });
});

describe('render (plan §4.4)', () => {
  it('renders the four lists with a generated line and short evidence refs', () => {
    const ulid = '01HX0000000000000000009J8K';
    const md = renderRetrospective(
      { ...emptyRetro(), worked_on: [{ text: 'Built the thing', evidence: [ulid] }] },
      { entryCount: 3, generated: '2026-06-10' }
    );
    expect(md).toContain('_Generated 2026-06-10 from 3 entries');
    expect(md).toContain('## Worked on');
    expect(md).toContain('## Successes');
    expect(md).toContain('## Failures');
    expect(md).toContain('## Lessons');
    expect(md).toContain(`[${id6(ulid)}]`);
  });
});

describe('privacy strip at the generator chokepoint (plan §4.5)', () => {
  it('publicEntries removes any reduce region from entry bodies', () => {
    const body = upsertMarkedBlock('Public prose.', 'SECRET DERIVED CONTENT');
    const [out] = publicEntries([entry({ id: 'A', date: '2024-01-01' }, body)]);
    expect(out.body).toContain('Public prose.');
    expect(out.body).not.toContain('whoami:reduce');
    expect(out.body).not.toContain('SECRET DERIVED CONTENT');
  });
});
