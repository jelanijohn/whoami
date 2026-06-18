import { describe, expect, it } from 'vitest';
import type { Llm } from '../../types';
import { parseWebsite } from './pipeline';
import type { FetchedPage } from './types';

function page(mainText: string, finalUrl = 'https://jane.example/about'): FetchedPage {
  return {
    url: finalUrl,
    finalUrl,
    mainText,
    structured: { jsonLd: [], openGraph: {}, meta: {} },
    outboundLinks: []
  };
}

const reply = (items: unknown[]): string => JSON.stringify({ items });

const WIN = {
  type: 'win',
  title: 'Founded Open Atlas',
  start: '2021',
  excerpt: 'Founded Open Atlas in 2021'
};

describe('parseWebsite', () => {
  it('bad_chunk_reported_not_thrown', async () => {
    const badLlm: Llm = { complete: async () => 'definitely not json {' };
    const { items, errors } = await parseWebsite(badLlm, [page('Founded Open Atlas in 2021.')]);
    expect(items).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /chunk 1\/1 failed/.test(e))).toBe(true);
  });

  it('dedupes_items_across_chunks', async () => {
    let calls = 0;
    const llm: Llm = {
      complete: async () => {
        calls++;
        return reply([WIN]);
      }
    };
    // A tiny token budget splits the two blank-line-separated blocks into
    // separate chunks; the stub returns the same item for each.
    const p = page('I led the platform team at Acme Corp from 2019.\n\nFounded Open Atlas in 2021.');
    const { items } = await parseWebsite(llm, [p], { tokenBudget: 1 });
    expect(calls).toBeGreaterThan(1); // really did chunk
    expect(items).toHaveLength(1); // deduped by sourceId across chunks
    expect(items[0].source).toBe('website');
    // source_page provenance is stamped from the page the excerpt was found in.
    expect(items[0].extraFrontmatter?.source_page).toBe('https://jane.example/about');
  });
});
