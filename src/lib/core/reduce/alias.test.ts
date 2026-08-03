import { describe, it, expect } from 'vitest';
import { buildAliasTable, expandIds, expandRetro, aliasRetro } from './alias';
import { emptyRetro } from './schema';
import { filterByEvidence } from './parse';

const U1 = '01HX00000000000000000000A1';
const U2 = '01HX00000000000000000000B2';
const U3 = '01HX00000000000000000000C3';

describe('buildAliasTable', () => {
  it('numbers E1..En in input order, reverse inverts forward', () => {
    const t = buildAliasTable([U1, U2, U3]);
    expect([...t.forward.entries()]).toEqual([
      [U1, 'E1'],
      [U2, 'E2'],
      [U3, 'E3']
    ]);
    for (const [id, alias] of t.forward) expect(t.reverse.get(alias)).toBe(id);
  });

  it('a duplicate id keeps its first alias (reverse stays bijective)', () => {
    const t = buildAliasTable([U1, U2, U1]);
    expect(t.forward.get(U1)).toBe('E1');
    expect(t.forward.size).toBe(2);
    expect(t.reverse.size).toBe(2);
  });
});

describe('expandIds', () => {
  const t = buildAliasTable([U1, U2]);

  it('maps aliases back to real ids', () => {
    expect(expandIds(['E2', 'E1'], t)).toEqual([U2, U1]);
  });

  it('passes unknown strings through unchanged; the evidence filter drops them', () => {
    expect(expandIds(['E999', 'junk', U3], t)).toEqual(['E999', 'junk', U3]);
    const retro = { ...emptyRetro(), lessons: [{ text: 'ghost', evidence: expandIds(['E999'], t) }] };
    expect(filterByEvidence(retro, new Set([U1, U2])).lessons).toEqual([]);
  });
});

describe('expandRetro / aliasRetro', () => {
  const t = buildAliasTable([U1, U2]);
  const aliased = {
    ...emptyRetro(),
    worked_on: [{ text: 'did x', evidence: ['E1'], date: '2024-01-01' }],
    successes: [{ text: 'shipped', evidence: ['E1', 'E2'] }]
  };

  it('expands all four lists, preserving text and date', () => {
    const real = expandRetro(aliased, t);
    expect(real.worked_on).toEqual([{ text: 'did x', evidence: [U1], date: '2024-01-01' }]);
    expect(real.successes).toEqual([{ text: 'shipped', evidence: [U1, U2] }]);
    expect(real.failures).toEqual([]);
  });

  it('round-trips through aliasRetro and does not mutate its input', () => {
    const real = expandRetro(aliased, t);
    expect(aliasRetro(real, t)).toEqual(aliased);
    expect(aliased.worked_on[0].evidence).toEqual(['E1']); // input untouched
    expect(real.worked_on[0].evidence).toEqual([U1]);
  });
});
