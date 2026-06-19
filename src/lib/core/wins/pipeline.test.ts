import { describe, it, expect } from 'vitest';
import { draftWins } from './pipeline';
import type { Entry, EntryFrontmatter, Llm, LlmCompletionRequest } from '../types';

function entry(fm: Partial<EntryFrontmatter> & { id: string; date: string }, body = ''): Entry {
  return { frontmatter: { type: 'journal', title: 't', private: false, ...fm }, body };
}

/** A canned model that records its calls and replies with a fixed string. */
function cannedLlm(reply: string): Llm & { calls: LlmCompletionRequest[] } {
  const calls: LlmCompletionRequest[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      return reply;
    }
  };
}

const entries = [
  entry({ id: 'A', date: '2024-01-01' }, 'shipped the importer'),
  entry({ id: 'B', date: '2024-02-01' }, 'cut latency in half')
];

describe('draftWins pipeline', () => {
  it('returns the filtered list from a canned reply with exactly one complete call', async () => {
    const llm = cannedLlm(
      JSON.stringify({ wins: [{ text: 'Shipped the importer', evidence: ['A', 'B'] }] })
    );
    const out = await draftWins(llm, { entries });
    expect(out).toEqual([{ text: 'Shipped the importer', evidence: ['A', 'B'] }]);
    expect(llm.calls).toHaveLength(1);
  });

  it('drops drafts citing an unselected id', async () => {
    const llm = cannedLlm(
      JSON.stringify({
        wins: [
          { text: 'Grounded', evidence: ['A'] },
          { text: 'Ungrounded', evidence: ['Z'] }
        ]
      })
    );
    expect(await draftWins(llm, { entries })).toEqual([{ text: 'Grounded', evidence: ['A'] }]);
  });

  it('returns [] (no throw) when the model grounds nothing', async () => {
    const llm = cannedLlm(JSON.stringify({ wins: [] }));
    expect(await draftWins(llm, { entries })).toEqual([]);
  });

  it('throws on a malformed reply', async () => {
    const llm = cannedLlm('totally not json');
    await expect(draftWins(llm, { entries })).rejects.toThrow(/not valid JSON/);
  });

  it('passes the maxTokens override through to the model', async () => {
    const llm = cannedLlm(JSON.stringify({ wins: [] }));
    await draftWins(llm, { entries, maxTokens: 1234 });
    expect(llm.calls[0].maxTokens).toBe(1234);
  });
});
