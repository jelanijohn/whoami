import { describe, it, expect } from 'vitest';
import { parseWins, filterWinsByEvidence } from './parse';

describe('parseWins', () => {
  it('parses a clean payload', () => {
    const raw = '{"wins":[{"text":"Shipped X","evidence":["A","B"]}]}';
    expect(parseWins(raw).wins).toEqual([{ text: 'Shipped X', evidence: ['A', 'B'] }]);
  });

  it('tolerates a prose preamble', () => {
    const raw = 'Here are the wins:\n{"wins":[{"text":"Did a thing","evidence":["A"]}]}';
    expect(parseWins(raw).wins).toEqual([{ text: 'Did a thing', evidence: ['A'] }]);
  });

  it('tolerates a ```json code fence', () => {
    const raw = '```json\n{"wins":[{"text":"Did a thing","evidence":["A"]}]}\n```';
    expect(parseWins(raw).wins).toEqual([{ text: 'Did a thing', evidence: ['A'] }]);
  });

  it('drops a draft with no non-empty text and coerces evidence to string[]', () => {
    const raw = JSON.stringify({
      wins: [
        { text: '  ', evidence: ['A'] }, // blank text → dropped
        { text: 'Kept', evidence: ['A', 7, 'B'] } // non-strings filtered out
      ]
    });
    expect(parseWins(raw).wins).toEqual([{ text: 'Kept', evidence: ['A', 'B'] }]);
  });

  it('treats a missing "wins" key as an empty payload', () => {
    expect(parseWins('{}').wins).toEqual([]);
  });

  it('throws with a truncation hint on a truncated reply', () => {
    const raw = '{"wins":[{"text":"Shipped a really long thing that got cut off';
    expect(() => parseWins(raw)).toThrow(/truncated/);
  });

  it('throws on a non-object reply', () => {
    expect(() => parseWins('not json at all')).toThrow(/not valid JSON/);
  });

  it('throws when "wins" is not an array', () => {
    expect(() => parseWins('{"wins":"nope"}')).toThrow(/not an array/);
  });
});

describe('filterWinsByEvidence', () => {
  const valid = new Set(['A', 'B', 'C']);

  it('keeps a fully-grounded draft', () => {
    const payload = { wins: [{ text: 'x', evidence: ['A', 'B'] }] };
    expect(filterWinsByEvidence(payload, valid)).toEqual(payload.wins);
  });

  it('drops a draft with empty evidence', () => {
    expect(filterWinsByEvidence({ wins: [{ text: 'x', evidence: [] }] }, valid)).toEqual([]);
  });

  it('drops a draft citing an out-of-set id', () => {
    expect(filterWinsByEvidence({ wins: [{ text: 'x', evidence: ['A', 'Z'] }] }, valid)).toEqual([]);
  });
});
