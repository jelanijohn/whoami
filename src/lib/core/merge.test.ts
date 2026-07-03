import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMergedEntry,
  mergedTitleDefault,
  mergeLedger,
  normalizedTitleKey,
  ticketOf
} from './merge';
import { makeEntry } from './entry';
import { mapGithubCommitNode, mapGithubGraphqlNode } from './ingest/github';
import { shortcutEnrichment, stripShortcutBlock, type ShortcutStory } from './ingest/shortcut';
import { rawItemToEntryInput, stageItems } from './ingest/pipeline';
import type { RawItem } from './ingest/types';
import { createNodePlatform } from './platform-node';
import { RecordStore } from './record';
import type { Entry, Platform } from './types';

// --- Fixtures: real inbox shapes — mapGithubCommitNode output staged through
// --- rawItemToEntryInput (spec §7 phase 1). ---------------------------------

/** Distinct 40-hex SHA whose short id is unique and whose lexicographic order
 * follows `i` (a stable tie-break fixture). */
const sha = (i: number) => `${String(i).padStart(4, '0')}${'d'.repeat(36)}`;
const short = (s: string) => s.slice(0, 7);

function commitNode(opts: {
  oid: string;
  headline: string;
  message?: string;
  date?: string;
  additions?: number;
  deletions?: number;
  files?: number;
}) {
  return {
    oid: opts.oid,
    messageHeadline: opts.headline,
    messageBody: opts.message ?? '',
    authoredDate: opts.date ? `${opts.date}T12:00:00Z` : undefined,
    additions: opts.additions ?? 10,
    deletions: opts.deletions ?? 2,
    changedFilesIfAvailable: opts.files ?? 1,
    parents: { totalCount: 1 },
    url: `https://github.com/acme/web/commit/${opts.oid}`
  };
}

const STORY: ShortcutStory = {
  id: '57886',
  name: 'Promo banner disclaimer',
  type: 'feature',
  state: 'Done'
};

/** Fold Shortcut enrichment onto a RawItem exactly like
 * `enrichRawItemsWithShortcut` does (without the network). */
function enrich(item: RawItem, story: ShortcutStory = STORY): RawItem {
  const { frontmatter, bodyBlock } = shortcutEnrichment(story);
  item.extraFrontmatter = { ...(item.extraFrontmatter ?? {}), ...frontmatter };
  const base = stripShortcutBlock(item.body ?? '');
  item.body = base ? `${base}\n\n${bodyBlock}` : bodyBlock;
  return item;
}

function commitItem(opts: Parameters<typeof commitNode>[0] & { enriched?: boolean }): RawItem {
  const item = mapGithubCommitNode(commitNode(opts), 'acme/web');
  return opts.enriched ? enrich(item) : item;
}

function candidateOf(item: RawItem, priv = true): Entry {
  return makeEntry(rawItemToEntryInput(item, '2026-07-01T00:00:00.000Z', undefined, priv));
}

/** N same-ticket commit candidates, dated 2026-06-01 … ascending. */
function ticketCommits(
  n: number,
  messageOf: (i: number) => string,
  opts: { enriched?: boolean } = { enriched: true }
): Entry[] {
  return Array.from({ length: n }, (_, i) =>
    candidateOf(
      commitItem({
        oid: sha(i),
        headline: `sc-57886 promo banner disclaimer ${i + 1}`,
        message: messageOf(i),
        date: `2026-06-${String(i + 1).padStart(2, '0')}`,
        additions: 10,
        deletions: 2,
        files: 1,
        enriched: opts.enriched
      })
    )
  );
}

const undate = (e: Entry): Entry => ({ ...e, frontmatter: { ...e.frontmatter, date: '' } });

// --- §1.1 ticketOf ------------------------------------------------------------

describe('ticketOf (spec §1.1)', () => {
  it('reads shortcut_ids[0]', () => {
    const c = ticketCommits(2, () => '')[0];
    expect(c.frontmatter.shortcut_ids).toEqual(['57886']);
    expect(ticketOf(c)).toBe('57886');
  });

  it('falls back to shortcut.id', () => {
    const c = ticketCommits(2, () => '')[0];
    const fm = { ...c.frontmatter };
    delete (fm as Record<string, unknown>).shortcut_ids;
    expect(ticketOf({ ...c, frontmatter: fm })).toBe('57886');
  });

  it("'' otherwise", () => {
    const c = candidateOf(commitItem({ oid: sha(1), headline: 'plain refactor', date: '2026-06-01' }));
    expect(ticketOf(c)).toBe('');
  });
});

// --- §1.2 normalizedTitleKey ----------------------------------------------------

describe('normalizedTitleKey (spec §1.2)', () => {
  it('separator variants of the ref produce the same key', () => {
    expect(normalizedTitleKey('Sc 57886 promo banner disclaimer')).toBe(
      normalizedTitleKey('sc-57886 promo banner disclaimer')
    );
    expect(normalizedTitleKey('sc-57886 promo banner disclaimer')).toBe('promo banner disclaimer');
  });

  it('keeps typos — no spell-correction (brutal accuracy)', () => {
    expect(normalizedTitleKey('Sc 57886 add discliamer to promo banner')).toBe(
      'add discliamer to promo banner'
    );
  });

  it("a ref-only title yields ''", () => {
    expect(normalizedTitleKey('sc-57886')).toBe('');
  });

  it('an invalid pattern override never throws (no stripping)', () => {
    expect(() => normalizedTitleKey('sc-1 fix thing', '(')).not.toThrow();
    expect(normalizedTitleKey('sc-1 fix thing', '(')).toBe('sc 1 fix thing');
  });
});

// --- §1.3 buildMergedEntry -------------------------------------------------------

describe('buildMergedEntry (spec §1.3)', () => {
  it('merges_15_same_ticket_commits', () => {
    // Ten commits carry the same message body, five carry none (D5 dedupe).
    const candidates = ticketCommits(15, (i) =>
      i < 10 ? 'Part of the promo banner disclaimer work.' : ''
    );
    // Shuffle so the build's own ordering is exercised.
    const shuffled = [...candidates].reverse();
    const merged = buildMergedEntry(shuffled, { title: 'sc-57886: Promo banner disclaimer' });
    const fm = merged.frontmatter;

    // D2 provenance: scalar = earliest commit's SHA, array = the full set.
    expect(fm.source).toBe('github');
    expect(fm.source_id).toBe(sha(0));
    expect(fm.source_ids).toHaveLength(15);
    expect(fm.source_ids).toEqual(Array.from({ length: 15 }, (_, i) => sha(i)));
    expect(fm.merged_count).toBe(15);
    expect(fm.reviewed).toBe(true);
    expect(fm.date).toBe('2026-06-15'); // max valid constituent date
    expect(fm.change_size).toEqual({ additions: 150, deletions: 30, changed_files: 15 });
    expect(fm.shortcut_ids).toEqual(['57886']);
    expect(fm.shortcut).toMatchObject({ id: '57886' });
    expect(fm.links).toHaveLength(15);
    expect(fm.source_url).toBe(`https://github.com/acme/web/commit/${sha(0)}`);

    // Header + 15 ledger lines, ascending by date.
    expect(merged.body).toContain('Merged from 15 GitHub commits in acme/web.');
    const ledger = merged.body.split('\n').filter((l) => l.startsWith('- '));
    expect(ledger).toHaveLength(15);
    expect(ledger[0]).toBe(
      `- 2026-06-01 · ${short(sha(0))} · sc-57886 promo banner disclaimer 1 · +10 −2`
    );
    expect(ledger[14]).toContain('2026-06-15');

    // ONE deduped message block listing all ten carrier SHAs (D5).
    const blocks = merged.body.match(/^--- Message \(([^)]*)\) ---$/gm) ?? [];
    expect(blocks).toHaveLength(1);
    for (let i = 0; i < 10; i++) expect(blocks[0]).toContain(short(sha(i)));
    expect(merged.body).toContain('Part of the promo banner disclaimer work.');

    // Exactly one Shortcut block, always last (prohibition 8).
    expect(merged.body.match(/--- Shortcut ---/g)).toHaveLength(1);
    expect(stripShortcutBlock(merged.body)).not.toContain('--- Shortcut ---');
    expect(merged.body.indexOf('--- Shortcut ---')).toBeGreaterThan(
      merged.body.lastIndexOf('--- Message')
    );

    // A fresh artifact: no constituent ULID survives.
    expect(candidates.map((c) => c.frontmatter.id)).not.toContain(fm.id);
  });

  it('distinct_messages_each_get_a_block', () => {
    const texts = ['First approach.', 'Second approach.', 'First approach.'];
    const candidates = ticketCommits(3, (i) => texts[i], { enriched: false });
    const merged = buildMergedEntry(candidates, { title: 'Promo banner disclaimer' });
    const headers = merged.body.match(/^--- Message \(([^)]*)\) ---$/gm) ?? [];
    expect(headers).toHaveLength(2);
    // First-seen order; identical texts collapse to one block with both carriers.
    expect(headers[0]).toBe(`--- Message (${short(sha(0))}, ${short(sha(2))}) ---`);
    expect(headers[1]).toBe(`--- Message (${short(sha(1))}) ---`);
  });

  it('date_gate_throws_when_all_undated_and_no_override', () => {
    const candidates = ticketCommits(2, () => '').map(undate);
    expect(() => buildMergedEntry(candidates, { title: 'x' })).toThrow(/date/i);
  });

  it('override_date_wins', () => {
    const candidates = ticketCommits(2, () => '');
    const merged = buildMergedEntry(candidates, { title: 'x', date: '2025-01-31' });
    expect(merged.frontmatter.date).toBe('2025-01-31');
  });

  it('invalid_override_date_throws', () => {
    const candidates = ticketCommits(2, () => '');
    expect(() => buildMergedEntry(candidates, { title: 'x', date: 'Jan 3' })).toThrow(/YYYY-MM-DD/);
  });

  it('mixed_source_throws', () => {
    const [a, b] = ticketCommits(2, () => '');
    const alien = { ...b, frontmatter: { ...b.frontmatter, source: 'asana' } };
    expect(() => buildMergedEntry([a, alien], { title: 'x' })).toThrow(/source|GitHub/i);
  });

  it('single_candidate_throws', () => {
    const [a] = ticketCommits(2, () => '');
    expect(() => buildMergedEntry([a], { title: 'x' })).toThrow(/at least 2/);
  });

  it('non_github_throws', () => {
    const candidates = ticketCommits(2, () => '').map((c) => ({
      ...c,
      frontmatter: { ...c.frontmatter, source: 'shortcut' }
    }));
    expect(() => buildMergedEntry(candidates, { title: 'x' })).toThrow(/GitHub/i);
  });

  it('privacy_folds_most_protective', () => {
    const items = [
      commitItem({ oid: sha(0), headline: 'a', date: '2026-06-01' }),
      commitItem({ oid: sha(1), headline: 'b', date: '2026-06-02' }),
      commitItem({ oid: sha(2), headline: 'c', date: '2026-06-03' })
    ];
    const allPublic = items.map((i) => candidateOf(i, false));
    expect(buildMergedEntry(allPublic, { title: 'x' }).frontmatter.private).toBe(false);
    const onePrivate = [allPublic[0], candidateOf(items[1], true), allPublic[2]];
    expect(buildMergedEntry(onePrivate, { title: 'x' }).frontmatter.private).toBe(true);
  });

  it('triage_keys_never_carried', () => {
    const candidates = ticketCommits(2, () => '').map((c) => ({
      ...c,
      frontmatter: {
        ...c.frontmatter,
        triage_signal: 'frivolous',
        triage_reason: 'test',
        triage_source: 'prefilter',
        triage_at: '2026-07-01T00:00:00Z'
      }
    }));
    const fm = buildMergedEntry(candidates, { title: 'x' }).frontmatter as Record<string, unknown>;
    expect(fm.triage_signal).toBeUndefined();
    expect(fm.triage_reason).toBeUndefined();
    expect(fm.triage_source).toBeUndefined();
    expect(fm.triage_at).toBeUndefined();
    expect(fm.needs_date).toBeUndefined();
  });

  it('tags/project fold: union with overrides; shared project suggestion kept', () => {
    const candidates = ticketCommits(2, () => '');
    const merged = buildMergedEntry(candidates, { title: 'x', tags: ['banner', 'github'] });
    expect(merged.frontmatter.tags).toEqual(['github', 'commit', 'banner']);
    // All constituents suggest slugify('acme/web') — kept when no override.
    expect(merged.frontmatter.project).toBe('acme-web');
    const cleared = buildMergedEntry(candidates, { title: 'x', project: '' });
    expect(cleared.frontmatter.project).toBeUndefined();
    const overridden = buildMergedEntry(candidates, { title: 'x', project: 'client-site' });
    expect(overridden.frontmatter.project).toBe('client-site');
  });

  it('mixed commit/PR selection: "items" header and short ids kept for PRs', () => {
    const pr = mapGithubGraphqlNode({
      __typename: 'PullRequest',
      databaseId: 4242,
      title: 'sc-57886 promo banner disclaimer PR',
      state: 'MERGED',
      createdAt: '2026-06-02T10:00:00Z',
      closedAt: '2026-06-04T10:00:00Z',
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      repository: { nameWithOwner: 'acme/web' },
      url: 'https://github.com/acme/web/pull/7',
      body: 'The PR description.'
    });
    const candidates = [candidateOf(pr), ...ticketCommits(2, () => '', { enriched: false })];
    const merged = buildMergedEntry(candidates, { title: 'x' });
    expect(merged.body).toContain('Merged from 3 GitHub items in acme/web.');
    expect(merged.body).toContain('· 4242 ·'); // databaseId stays whole
    expect(merged.body).toContain('--- Message (4242) ---\nThe PR description.');
    expect(merged.frontmatter.change_size).toEqual({
      additions: 25,
      deletions: 5,
      changed_files: 4
    });
  });
});

// --- §1.4 mergedTitleDefault -----------------------------------------------------

describe('mergedTitleDefault (spec §1.4)', () => {
  it('the Shortcut story name wins', () => {
    const candidates = ticketCommits(3, () => '');
    expect(mergedTitleDefault(candidates)).toBe('sc-57886: Promo banner disclaimer');
  });

  it('falls back to the most frequent normalized title, first carrier rendering', () => {
    const candidates = [
      candidateOf(commitItem({ oid: sha(0), headline: 'sc-57886 promo banner disclaimer', date: '2026-06-01' })),
      candidateOf(commitItem({ oid: sha(1), headline: 'Sc 57886 promo banner disclaimer', date: '2026-06-02' })),
      candidateOf(commitItem({ oid: sha(2), headline: 'something else entirely', date: '2026-06-03' }))
    ];
    expect(mergedTitleDefault(candidates)).toBe('sc-57886 promo banner disclaimer');
  });

  it("falls back to the primary's title when no key repeats", () => {
    const candidates = [
      candidateOf(commitItem({ oid: sha(1), headline: 'later work', date: '2026-06-05' })),
      candidateOf(commitItem({ oid: sha(0), headline: 'earliest work', date: '2026-06-01' }))
    ];
    // "Most frequent" ties at 1 — first-seen (earliest constituent) wins.
    expect(mergedTitleDefault(candidates)).toBe('earliest work');
  });
});

// --- Phase 2: provenance projection & the store method (spec §7) ----------------

describe('promoteMerged & provenance (spec §2–3)', () => {
  let root: string;
  let platform: Platform;
  let store: RecordStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'whoami-merge-'));
    platform = createNodePlatform(':memory:');
    store = new RecordStore(platform, root);
    await store.init();
  });

  afterEach(async () => {
    await platform.db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function stageTicketCommits(n: number): Promise<string[]> {
    const items = Array.from({ length: n }, (_, i) =>
      commitItem({
        oid: sha(i),
        headline: `sc-57886 promo banner disclaimer ${i + 1}`,
        message: 'Part of the ticket.',
        date: `2026-06-${String(i + 1).padStart(2, '0')}`,
        enriched: true
      })
    );
    const report = await stageItems(store, items);
    expect(report.staged).toBe(n);
    return (await store.listCandidates()).map((c) => c.path!);
  }

  it('source_ids_project_into_provenance', async () => {
    const e = await store.createEntry({
      type: 'journal',
      title: 'merged fixture',
      date: '2026-06-15',
      extra: { source: 'github', source_id: 'a', source_ids: ['a', 'b', 'c'] }
    });
    const ids = await store.promotedSourceIds('github');
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
    expect(await store.findBySource('github', 'c')).toBe(e.frontmatter.id);
  });

  it('promoteMerged_write_order', async () => {
    const paths = await stageTicketCommits(3);
    const merged = await store.promoteMerged(paths, { title: 'sc-57886: Promo banner disclaimer' });

    // Merged file exists in entries/ with the expected frontmatter…
    expect(merged.path!.startsWith('entries/')).toBe(true);
    expect(await platform.fs.exists(join(root, merged.path!))).toBe(true);
    expect(merged.frontmatter.source_ids).toEqual([sha(0), sha(1), sha(2)]);
    expect(merged.frontmatter.merged_count).toBe(3);

    // …every constituent candidate file is gone…
    for (const p of paths) expect(await platform.fs.exists(join(root, p))).toBe(false);
    expect(await store.listCandidates()).toHaveLength(0);

    // …and the index has exactly one new row.
    const all = await store.listEntries({ includePrivate: true });
    expect(all).toHaveLength(1);
    expect(all[0].frontmatter.id).toBe(merged.frontmatter.id);
  });

  it('reimport_skips_all_constituents', async () => {
    const paths = await stageTicketCommits(3);
    await store.promoteMerged(paths, { title: 'Merged' });

    const batch = [0, 1, 2, 3].map((i) =>
      commitItem({ oid: sha(i), headline: `sc-57886 thing ${i}`, date: '2026-06-20' })
    );
    const report = await stageItems(store, batch);
    expect(report.skippedPromoted).toBe(3);
    expect(report.staged).toBe(1);
    const staged = await store.listCandidates();
    expect(staged).toHaveLength(1);
    expect(staged[0].frontmatter.source_id).toBe(sha(3));
  });

  it('promoteMerged_rejects_non_inbox_paths', async () => {
    const paths = await stageTicketCommits(2);
    const promoted = await store.promoteCandidate(paths[0]);
    await expect(
      store.promoteMerged([promoted.path!, paths[1]], { title: 'x' })
    ).rejects.toThrow(/inbox/i);
    // Nothing was consumed: the remaining candidate is still staged.
    expect(await store.listCandidates()).toHaveLength(1);
  });

  it('reject_group_appends_every_provenance (D3)', async () => {
    const paths = await stageTicketCommits(3);
    for (const p of paths) await store.rejectCandidate(p);
    const keys = await store.rejectedKeys();
    for (let i = 0; i < 3; i++) expect(keys.has(`github\t${sha(i)}`)).toBe(true);

    const batch = [0, 1, 2].map((i) =>
      commitItem({ oid: sha(i), headline: `retry ${i}`, date: '2026-06-20' })
    );
    const report = await stageItems(store, batch);
    expect(report.skippedRejected).toBe(3);
    expect(report.staged).toBe(0);
  });

  it('full_rebuild_reconstructs_array_provenance', async () => {
    const paths = await stageTicketCommits(3);
    await store.promoteMerged(paths, { title: 'Merged' });
    const before = await store.promotedSourceIds('github');
    expect(before.size).toBe(3);

    await store.fullRebuild();
    const after = await store.promotedSourceIds('github');
    expect(after).toEqual(before);
  });
});

// --- The ledger helper the dialog preview shares (spec §5.2) ---------------------

describe('mergeLedger', () => {
  it('matches the built body ledger, undated last with an em-dash', () => {
    const dated = ticketCommits(2, () => '', { enriched: false });
    const undated = undate(dated[1]);
    const lines = mergeLedger([undated, dated[0]]);
    expect(lines[0]).toContain('2026-06-01');
    expect(lines[1].startsWith('- — ·')).toBe(true);

    const merged = buildMergedEntry([undated, dated[0]], { title: 'x' });
    for (const line of lines) expect(merged.body).toContain(line);
  });
});
