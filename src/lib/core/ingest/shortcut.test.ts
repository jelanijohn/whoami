import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest } from '../types';
import {
  DEFAULT_SHORTCUT_REF,
  IMPORT_DESCRIPTION_CAP,
  extractShortcutRefs,
  mapShortcutStory,
  fetchShortcutStories,
  storyFrontmatter,
  shortcutEnrichment,
  stripShortcutBlock,
  enrichRawItemsWithShortcut,
  fetchShortcutMe,
  storyInvolvesMe,
  storyRoles,
  bisectWindow,
  queryShortcutStories,
  mapShortcutStoryToRawItem,
  fetchShortcutStoryItems,
  type ShortcutResolve
} from './shortcut';
import { mapGithubCommitNode, mapGithubGraphqlNode } from './github';
import type { RawItem } from './types';

// --- extractShortcutRefs (pure, spec §2.1) -----------------------------------

describe('extractShortcutRefs', () => {
  it('extracts a single sc-id, without the prefix', () => {
    expect(extractShortcutRefs('sc-57886 promo banner disclaimer')).toEqual(['57886']);
  });

  it('extracts multiple distinct ids in first-seen order', () => {
    expect(extractShortcutRefs('sc-2 then sc-1 then sc-3')).toEqual(['2', '1', '3']);
  });

  it('dedupes repeats within one text', () => {
    expect(extractShortcutRefs('sc-9 fix; relates to sc-9 and SC-9')).toEqual(['9']);
  });

  it('is case-insensitive (SC-123)', () => {
    expect(extractShortcutRefs('SC-123 and Sc-456')).toEqual(['123', '456']);
  });

  it('ignores non-matching digits in URLs and SHAs', () => {
    expect(extractShortcutRefs('see https://x.dev/disc-123 at abc1234 misc-55')).toEqual([]);
    // Digits fused into a longer word are not a ref (word-bounded).
    expect(extractShortcutRefs('sc-123abc')).toEqual([]);
    // ...but a ref inside a URL path IS one (bounded by `/`).
    expect(extractShortcutRefs('https://app.shortcut.com/acme/story/sc-777')).toEqual(['777']);
  });

  it('accepts a custom pattern (ABC-\\d+)', () => {
    expect(extractShortcutRefs('ABC-42 shipped, sc-1 ignored', 'ABC-\\d+')).toEqual(['42']);
  });

  it('swallows an unparseable pattern → []', () => {
    expect(extractShortcutRefs('sc-1', '(unclosed')).toEqual([]);
  });

  it('uses the pattern capture group as the id when one exists', () => {
    expect(extractShortcutRefs('ticket/57886-fix-banner', 'ticket\\/(\\d+)-\\w+')).toEqual(['57886']);
  });
});

// --- GitHub mapper integration (spec §2.2) -----------------------------------

const GQL_PR = {
  __typename: 'PullRequest',
  databaseId: 9876,
  number: 12,
  title: 'Add provider dispatch',
  url: 'https://github.com/acme/waid/pull/12',
  state: 'MERGED',
  createdAt: '2026-05-20T09:00:00Z',
  closedAt: '2026-06-01T10:00:00Z',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  repository: { nameWithOwner: 'acme/waid' }
};

const GQL_COMMIT = {
  oid: 'deadbeefcafe',
  messageHeadline: 'sc-57886 promo banner disclaimer',
  messageBody: 'Also touches sc-600.',
  authoredDate: '2026-06-10T08:00:00Z',
  url: 'https://github.com/acme/waid/commit/deadbeef',
  additions: 10,
  deletions: 2,
  changedFilesIfAvailable: 3,
  parents: { totalCount: 1 }
};

describe('github mappers extract shortcut refs', () => {
  it('no ref → no shortcut_ids and no meta.shortcut_id (byte-identical output)', () => {
    const pr = mapGithubGraphqlNode(GQL_PR);
    expect(pr.extraFrontmatter?.shortcut_ids).toBeUndefined();
    expect(pr.meta?.shortcut_id).toBeUndefined();
    // Explicit default pattern produces the same object as no argument.
    expect(mapGithubGraphqlNode(GQL_PR, DEFAULT_SHORTCUT_REF)).toEqual(pr);

    const commit = mapGithubCommitNode({ ...GQL_COMMIT, messageHeadline: 'fix', messageBody: '' }, 'acme/waid');
    expect(commit.extraFrontmatter?.shortcut_ids).toBeUndefined();
    expect(commit.meta?.shortcut_id).toBeUndefined();
  });

  it('ref in a PR title/body → shortcut_ids + meta.shortcut_id', () => {
    const item = mapGithubGraphqlNode({ ...GQL_PR, title: 'sc-57886 promo banner', body: 'covers sc-600 too' });
    expect(item.extraFrontmatter?.shortcut_ids).toEqual(['57886', '600']);
    expect(item.meta?.shortcut_id).toBe('57886'); // first-seen, string-valued
    // An issue with no change_size still gains extraFrontmatter for the refs.
    const issue = mapGithubGraphqlNode({ __typename: 'Issue', databaseId: 1, title: 'sc-1 bug' });
    expect(issue.extraFrontmatter?.shortcut_ids).toEqual(['1']);
  });

  it('ref in a commit headline/message → shortcut_ids + meta.shortcut_id', () => {
    const item = mapGithubCommitNode(GQL_COMMIT, 'acme/waid');
    expect(item.extraFrontmatter?.shortcut_ids).toEqual(['57886', '600']);
    expect(item.meta?.shortcut_id).toBe('57886');
    // Existing commit facts are untouched alongside the refs.
    expect(item.extraFrontmatter?.commit_sha).toBe('deadbeefcafe');
  });

  it('a custom pattern threads through; an invalid one degrades to none', () => {
    const item = mapGithubCommitNode({ ...GQL_COMMIT, messageHeadline: 'ABC-7 fix' }, 'acme/waid', 'ABC-\\d+');
    expect(item.extraFrontmatter?.shortcut_ids).toEqual(['7']);
    const bad = mapGithubCommitNode(GQL_COMMIT, 'acme/waid', '(broken');
    expect(bad.extraFrontmatter?.shortcut_ids).toBeUndefined();
  });
});

// --- mapShortcutStory (pure, spec §3.3) --------------------------------------

const RAW_STORY = {
  id: 57886,
  name: 'Promo banner disclaimer',
  story_type: 'feature',
  workflow_state_id: 500,
  epic_id: 42,
  group_id: 'uuid-team-1',
  project_id: 7,
  app_url: 'https://app.shortcut.com/acme/story/57886',
  created_at: '2026-05-01T10:00:00Z',
  started_at: '2026-05-03T10:00:00Z',
  completed_at: '2026-05-20T10:00:00Z',
  labels: [{ name: 'client' }, { name: 'promo' }],
  estimate: 3,
  description: 'Add the legal disclaimer under the promo banner.'
};

const RESOLVE: ShortcutResolve = {
  states: new Map<number | string, string>([[500, 'Done']]),
  epics: new Map<number | string, string>([[42, 'Summer promo']]),
  teams: new Map<number | string, string>([['uuid-team-1', 'Web']]),
  projects: new Map<number | string, string>([[7, 'Acme Client Portal']])
};

const EMPTY_RESOLVE: ShortcutResolve = {
  states: new Map(),
  epics: new Map(),
  teams: new Map(),
  projects: new Map()
};

describe('mapShortcutStory', () => {
  it('resolves state/epic/team names via the maps and iso-normalizes dates', () => {
    const s = mapShortcutStory(RAW_STORY, RESOLVE);
    expect(s.id).toBe('57886');
    expect(s.name).toBe('Promo banner disclaimer');
    expect(s.type).toBe('feature');
    expect(s.state).toBe('Done');
    expect(s.epic).toBe('Summer promo');
    expect(s.team).toBe('Web');
    expect(s.project).toBe('Acme Client Portal');
    expect(s.createdAt).toBe('2026-05-01');
    expect(s.startedAt).toBe('2026-05-03');
    expect(s.completedAt).toBe('2026-05-20');
    expect(s.labels).toEqual(['client', 'promo']);
    expect(s.estimate).toBe(3);
    expect(s.appUrl).toBe('https://app.shortcut.com/acme/story/57886');
  });

  it('an unresolvable id degrades to undefined, never throws', () => {
    const s = mapShortcutStory(RAW_STORY, EMPTY_RESOLVE);
    expect(s.state).toBeUndefined();
    expect(s.epic).toBeUndefined();
    expect(s.team).toBeUndefined();
    expect(s.project).toBeUndefined();
  });

  it('drops the description entirely when includeDescription is off (default)', () => {
    expect(mapShortcutStory(RAW_STORY, RESOLVE).description).toBeUndefined();
    expect(mapShortcutStory(RAW_STORY, RESOLVE, { includeDescription: false }).description).toBeUndefined();
  });

  it('pulls the description verbatim, bounded, when includeDescription is on', () => {
    const short = mapShortcutStory(RAW_STORY, RESOLVE, { includeDescription: true });
    expect(short.description).toBe('Add the legal disclaimer under the promo banner.');
    const long = mapShortcutStory(
      { ...RAW_STORY, description: 'word '.repeat(200) },
      RESOLVE,
      { includeDescription: true }
    );
    expect(long.description).toContain('… [description truncated at 500 chars]');
    expect(long.description!.length).toBeLessThan(600);
  });
});

// --- shortcutEnrichment (pure, spec §4) --------------------------------------

describe('shortcutEnrichment', () => {
  it('frontmatter carries only defined fields under `shortcut`', () => {
    const full = shortcutEnrichment(mapShortcutStory(RAW_STORY, RESOLVE));
    expect(full.frontmatter).toEqual({
      shortcut: {
        id: '57886',
        type: 'feature',
        state: 'Done',
        epic: 'Summer promo',
        team: 'Web',
        project: 'Acme Client Portal',
        created_at: '2026-05-01',
        started_at: '2026-05-03',
        completed_at: '2026-05-20',
        app_url: 'https://app.shortcut.com/acme/story/57886',
        labels: ['client', 'promo'],
        estimate: 3
      }
    });
    const sparse = shortcutEnrichment({ id: '1', name: 'Thing' });
    expect(sparse.frontmatter).toEqual({ shortcut: { id: '1' } });
  });

  it('bodyBlock opens with --- Shortcut --- and puts the name on the header line', () => {
    const { bodyBlock } = shortcutEnrichment(mapShortcutStory(RAW_STORY, RESOLVE));
    expect(bodyBlock.startsWith('--- Shortcut ---\n')).toBe(true);
    expect(bodyBlock).toContain('sc-57886 (feature, Done): Promo banner disclaimer');
    expect(bodyBlock).toContain('Epic: Summer promo');
  });

  it('appends the description verbatim when present', () => {
    const { bodyBlock } = shortcutEnrichment(
      mapShortcutStory(RAW_STORY, RESOLVE, { includeDescription: true })
    );
    expect(bodyBlock.endsWith('Add the legal disclaimer under the promo banner.')).toBe(true);
  });

  it('stripShortcutBlock removes a trailing block and is a no-op without one', () => {
    const { bodyBlock } = shortcutEnrichment({ id: '1', name: 'Thing' });
    expect(stripShortcutBlock(`facts here\n\n${bodyBlock}`)).toBe('facts here');
    expect(stripShortcutBlock('facts here')).toBe('facts here');
  });
});

// --- fetchShortcutStories (Http seam, spec §3.2) -------------------------------

/** Fake Http recording every request; routes match by URL substring. */
function fakeShortcutHttp(
  stories: Record<string, unknown>,
  requests: HttpRequest[],
  opts: { failResolution?: boolean } = {}
): Http {
  return {
    async request(req) {
      requests.push(req);
      const respond = (json: unknown) => ({
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(json)
      });
      if (/\/(workflows|epics|groups|projects)$/.test(req.url)) {
        if (opts.failResolution) return { status: 500, ok: false, headers: {}, text: 'boom' };
        if (req.url.endsWith('/workflows')) return respond([{ states: [{ id: 500, name: 'Done' }] }]);
        return respond([]);
      }
      const id = req.url.split('/').pop()!;
      const story = stories[id];
      if (!story) return { status: 404, ok: false, headers: {}, text: 'not found' };
      return respond(story);
    }
  };
}

describe('fetchShortcutStories', () => {
  it('dedupes ids before fetching — 15 refs to one story cost ONE GET', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({ '57886': RAW_STORY }, requests);
    const out = await fetchShortcutStories(http, 'tok', Array(15).fill('57886'));
    expect(out.size).toBe(1);
    expect(out.get('57886')?.state).toBe('Done'); // resolved via /workflows
    const storyGets = requests.filter((r) => r.url.includes('/stories/'));
    expect(storyGets).toHaveLength(1);
    // 4 resolution calls + 1 story = 5 total, independent of ref count.
    expect(requests).toHaveLength(5);
  });

  it('skips a per-id 404 and continues the batch', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({ '2': { id: 2, name: 'Alive' } }, requests);
    const out = await fetchShortcutStories(http, 'tok', ['1', '2']);
    expect(out.has('1')).toBe(false);
    expect(out.get('2')?.name).toBe('Alive');
  });

  it('degrades to unresolved names when the resolution calls fail', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({ '57886': RAW_STORY }, requests, { failResolution: true });
    const out = await fetchShortcutStories(http, 'tok', ['57886']);
    expect(out.get('57886')?.name).toBe('Promo banner disclaimer');
    expect(out.get('57886')?.state).toBeUndefined();
  });

  it('authenticates with a Shortcut-Token header, NOT bearer', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({ '57886': RAW_STORY }, requests);
    await fetchShortcutStories(http, 'sekret', ['57886']);
    for (const req of requests) {
      expect(req.headers?.['Shortcut-Token']).toBe('sekret');
      expect(req.headers?.Authorization).toBeUndefined();
    }
  });
});

// --- enrichRawItemsWithShortcut (at-import batch, spec §5) --------------------

describe('enrichRawItemsWithShortcut', () => {
  const refItem = (): RawItem => ({
    source: 'github',
    sourceId: 'sha1',
    title: 'sc-57886 promo banner',
    date: '2026-06-10',
    body: 'GitHub commit in acme/web.',
    extraFrontmatter: { commit_sha: 'sha1', shortcut_ids: ['57886'] },
    meta: { type: 'commit', shortcut_id: '57886' }
  });

  it('folds the story facts + block into ref-bearing items, leaves others alone', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({ '57886': RAW_STORY }, requests);
    const plain: RawItem = { source: 'github', sourceId: 'x', title: 'no ref', date: '', body: 'plain' };
    const items = [refItem(), plain];
    await enrichRawItemsWithShortcut(http, 'tok', items);
    expect((items[0].extraFrontmatter?.shortcut as Record<string, unknown>).id).toBe('57886');
    expect(items[0].body).toContain('--- Shortcut ---');
    expect(items[0].body).toContain('sc-57886 (feature, Done): Promo banner disclaimer');
    expect(items[1].body).toBe('plain');
    expect(items[1].extraFrontmatter).toBeUndefined();
  });

  it('makes no network calls when nothing carries a ref', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeShortcutHttp({}, requests);
    const plain: RawItem = { source: 'github', sourceId: 'x', title: 'no ref', date: '' };
    await enrichRawItemsWithShortcut(http, 'tok', [plain]);
    expect(requests).toHaveLength(0);
  });

  it('a vanished story leaves the item ref-tagged but un-enriched', async () => {
    const http = fakeShortcutHttp({}, []);
    const items = [refItem()];
    await enrichRawItemsWithShortcut(http, 'tok', items);
    expect(items[0].extraFrontmatter?.shortcut).toBeUndefined();
    expect(items[0].extraFrontmatter?.shortcut_ids).toEqual(['57886']);
    expect(items[0].body).not.toContain('--- Shortcut ---');
  });
});

// --- Story import (shortcut-story-import spec §10, T1–T9) ---------------------

const ME = 'uuid-me';

/** A followed story payload as Query Stories returns it (StorySlim shape). */
const FOLLOWED_STORY = {
  ...RAW_STORY,
  follower_ids: ['uuid-other', ME],
  owner_ids: [ME],
  requested_by_id: ME
};

// T1
describe('storyInvolvesMe', () => {
  it('true when my uuid is in follower_ids', () => {
    expect(storyInvolvesMe(FOLLOWED_STORY, ME)).toBe(true);
  });

  it('false when absent, missing, or malformed (fail closed)', () => {
    expect(storyInvolvesMe({ ...RAW_STORY, follower_ids: ['uuid-other'] }, ME)).toBe(false);
    expect(storyInvolvesMe(RAW_STORY, ME)).toBe(false); // no follower_ids at all
    expect(storyInvolvesMe({ follower_ids: 'not-an-array' }, ME)).toBe(false);
    expect(storyInvolvesMe(null, ME)).toBe(false);
    expect(storyInvolvesMe({ follower_ids: [42] }, ME)).toBe(false); // non-string ids
  });
});

// T2
describe('storyRoles', () => {
  it('owner+requester+follower for a self-created self-owned story, in fixed order', () => {
    expect(storyRoles(FOLLOWED_STORY, ME)).toEqual(['owner', 'requester', 'follower']);
  });

  it("['follower'] for a merely-followed story", () => {
    const watched = { ...RAW_STORY, follower_ids: [ME], owner_ids: ['uuid-other'], requested_by_id: 'uuid-other' };
    expect(storyRoles(watched, ME)).toEqual(['follower']);
  });

  it('requester without ownership keeps the fixed order', () => {
    const requested = { ...RAW_STORY, follower_ids: [ME], owner_ids: [], requested_by_id: ME };
    expect(storyRoles(requested, ME)).toEqual(['requester', 'follower']);
  });
});

// T3
describe('bisectWindow', () => {
  it('splits a 10-day window into adjacent non-overlapping halves', () => {
    const [a, b] = bisectWindow('2026-01-01', '2026-01-10');
    expect(a).toEqual({ since: '2026-01-01', until: '2026-01-05' });
    expect(b).toEqual({ since: '2026-01-06', until: '2026-01-10' });
  });

  it('splits a 2-day window into two single days', () => {
    const [a, b] = bisectWindow('2026-01-01', '2026-01-02');
    expect(a).toEqual({ since: '2026-01-01', until: '2026-01-01' });
    expect(b).toEqual({ since: '2026-01-02', until: '2026-01-02' });
  });

  it('a 1-day window yields a left half identical to the input (the depth stop)', () => {
    const [a, b] = bisectWindow('2026-01-01', '2026-01-01');
    expect(a).toEqual({ since: '2026-01-01', until: '2026-01-01' });
    // The right half is inverted (since > until) and matches nothing.
    expect(b).toEqual({ since: '2026-01-02', until: '2026-01-01' });
  });
});

/** Fake Http for the story-import endpoints; `search` decides each
 * POST /stories/search response from its parsed body. */
function fakeImportHttp(
  requests: HttpRequest[],
  opts: {
    member?: unknown;
    search?: (body: Record<string, unknown>) => unknown[];
  } = {}
): Http {
  return {
    async request(req) {
      requests.push(req);
      const respond = (json: unknown) => ({
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(json)
      });
      if (req.url.endsWith('/member')) {
        return respond(opts.member ?? { id: ME, mention_name: 'jelan', name: 'Jelani' });
      }
      if (req.url.endsWith('/stories/search')) {
        const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        return respond(opts.search ? opts.search(body) : []);
      }
      if (req.url.endsWith('/workflows')) return respond([{ states: [{ id: 500, name: 'Done' }] }]);
      if (/\/(epics|groups|projects)$/.test(req.url)) return respond([]);
      return { status: 404, ok: false, headers: {}, text: 'not found' };
    }
  };
}

// T8
describe('fetchShortcutMe', () => {
  it('maps id/mention_name/name', async () => {
    const http = fakeImportHttp([]);
    expect(await fetchShortcutMe(http, 'tok')).toEqual({ id: ME, mentionName: 'jelan', name: 'Jelani' });
  });

  it('a missing id throws — the import cannot proceed without an identity', async () => {
    const http = fakeImportHttp([], { member: { mention_name: 'jelan' } });
    await expect(fetchShortcutMe(http, 'tok')).rejects.toThrow(/no member id/);
  });
});

// T4
describe('queryShortcutStories', () => {
  it('POSTs includes_description + ISO date-time bounds and NO archived key', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeImportHttp(requests, { search: () => [FOLLOWED_STORY] });
    const out = await queryShortcutStories(http, 'tok', { since: '2026-01-01', until: '2026-06-30' });
    expect(out).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers?.['Shortcut-Token']).toBe('tok');
    const body = JSON.parse(requests[0].body ?? '{}');
    expect(body).toEqual({
      includes_description: true,
      updated_at_start: '2026-01-01T00:00:00Z',
      updated_at_end: '2026-06-30T23:59:59Z'
    });
    expect('archived' in body).toBe(false);
  });

  it('omits absent bounds from the body', async () => {
    const requests: HttpRequest[] = [];
    const http = fakeImportHttp(requests, { search: () => [] });
    await queryShortcutStories(http, 'tok', {});
    expect(JSON.parse(requests[0].body ?? '{}')).toEqual({ includes_description: true });
  });

  it('a cap-length response triggers exactly one bisection level', async () => {
    const requests: HttpRequest[] = [];
    const capped = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const http = fakeImportHttp(requests, {
      search: (body) =>
        // Only the full window is truncated; each half comes back small.
        body.updated_at_start === '2026-01-01T00:00:00Z' && body.updated_at_end === '2026-01-10T23:59:59Z'
          ? capped
          : [FOLLOWED_STORY]
    });
    const out = await queryShortcutStories(http, 'tok', { since: '2026-01-01', until: '2026-01-10' });
    // 1 truncated call + 2 half-window calls, results concatenated.
    expect(requests).toHaveLength(3);
    expect(out).toHaveLength(2);
    const bodies = requests.map((r) => JSON.parse(r.body ?? '{}'));
    expect(bodies[1].updated_at_end).toBe('2026-01-05T23:59:59Z');
    expect(bodies[2].updated_at_start).toBe('2026-01-06T00:00:00Z');
  });

  it('an unsplittable truncated window reports the truncation, never drops', async () => {
    const capped = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const errors: string[] = [];
    const http = fakeImportHttp([], { search: () => capped });
    const out = await queryShortcutStories(
      http,
      'tok',
      { since: '2026-01-01', until: '2026-01-01' },
      { errors }
    );
    expect(out).toHaveLength(1000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cannot be split further');
  });

  it('a truncated open-ended window throws with a set-an-explicit-window hint', async () => {
    const capped = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const http = fakeImportHttp([], { search: () => capped });
    await expect(queryShortcutStories(http, 'tok', { since: '2026-01-01' })).rejects.toThrow(
      /explicit since and until/
    );
  });
});

// T5
describe('mapShortcutStoryToRawItem', () => {
  const story = mapShortcutStory(FOLLOWED_STORY, RESOLVE, {
    includeDescription: true,
    cap: IMPORT_DESCRIPTION_CAP
  });

  it('maps a full story to a shortcut-sourced RawItem', () => {
    const item = mapShortcutStoryToRawItem(story, ['owner', 'requester', 'follower']);
    expect(item.source).toBe('shortcut');
    expect(item.sourceId).toBe('57886');
    expect(item.title).toBe('Promo banner disclaimer');
    expect(item.date).toBe('2026-05-20'); // completed_at wins
    expect(item.url).toBe('https://app.shortcut.com/acme/story/57886');
    expect(item.suggestedType).toBe('journal');
    expect(item.suggestedTags).toEqual(['shortcut', 'feature']);
    expect(item.body).toBe('--- Description ---\nAdd the legal disclaimer under the promo banner.');
    expect(item.suggestedProject).toBeUndefined();
  });

  it('date preference falls back completed > started > created', () => {
    const noCompleted = { ...story, completedAt: undefined };
    expect(mapShortcutStoryToRawItem(noCompleted, ['follower']).date).toBe('2026-05-03');
    const createdOnly = { ...story, completedAt: undefined, startedAt: undefined };
    expect(mapShortcutStoryToRawItem(createdOnly, ['follower']).date).toBe('2026-05-01');
  });

  it('frontmatter is the shared shortcut object plus roles — and no shortcut_ids', () => {
    const item = mapShortcutStoryToRawItem(story, ['owner', 'follower']);
    expect(item.extraFrontmatter).toEqual({
      shortcut: {
        ...storyFrontmatter(story).shortcut,
        roles: ['owner', 'follower']
      }
    });
    expect(item.extraFrontmatter?.shortcut_ids).toBeUndefined();
  });

  it('no description ⇒ no body block', () => {
    const bare = mapShortcutStory(FOLLOWED_STORY, RESOLVE); // description dropped
    expect(mapShortcutStoryToRawItem(bare, ['follower']).body).toBeUndefined();
  });
});

// T6
describe('description caps (import vs enrichment)', () => {
  const longRaw = { ...RAW_STORY, description: 'word '.repeat(500) }; // 2,500 chars

  it('the import cap truncates at the last whitespace ≤ 2000 with the marker', () => {
    const s = mapShortcutStory(longRaw, RESOLVE, { includeDescription: true, cap: IMPORT_DESCRIPTION_CAP });
    expect(s.description).toContain('… [description truncated at 2000 chars]');
    const head = s.description!.split('\n\n')[0];
    expect(head.length).toBeLessThanOrEqual(2000);
    expect(head.endsWith('word')).toBe(true); // never mid-word
  });

  it('the enrichment default still truncates at 500', () => {
    const s = mapShortcutStory(longRaw, RESOLVE, { includeDescription: true });
    expect(s.description).toContain('… [description truncated at 500 chars]');
  });
});

// T7
describe('fetchShortcutStoryItems', () => {
  it('keeps only my stories; resolution maps fetched once', async () => {
    const requests: HttpRequest[] = [];
    const notMine = { ...RAW_STORY, id: 999, name: 'Someone else', follower_ids: ['uuid-other'] };
    const http = fakeImportHttp(requests, { search: () => [FOLLOWED_STORY, notMine] });
    const items = await fetchShortcutStoryItems(http, 'tok', { since: '2026-01-01', until: '2026-06-30' });
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe('57886');
    // Resolved via the once-fetched maps.
    expect((items[0].extraFrontmatter?.shortcut as Record<string, unknown>).state).toBe('Done');
    // 1 member + 1 search + 4 maps.
    expect(requests).toHaveLength(6);
    expect(requests.filter((r) => r.url.endsWith('/workflows'))).toHaveLength(1);
  });

  it('a zero-match window fetches no resolution maps (2 requests total)', async () => {
    const requests: HttpRequest[] = [];
    const notMine = { ...RAW_STORY, follower_ids: ['uuid-other'] };
    const http = fakeImportHttp(requests, { search: () => [notMine] });
    const items = await fetchShortcutStoryItems(http, 'tok', { since: '2026-01-01', until: '2026-06-30' });
    expect(items).toEqual([]);
    expect(requests).toHaveLength(2);
  });
});

// T9 — enrichment regression pin: after the storyFrontmatter extraction the
// enrichment output is byte-identical (the full-fixture equality lives in the
// shortcutEnrichment suite above; this pins the two paths to ONE builder).
describe('storyFrontmatter extraction (T9)', () => {
  it('shortcutEnrichment frontmatter === storyFrontmatter output', () => {
    const story = mapShortcutStory(RAW_STORY, RESOLVE);
    expect(shortcutEnrichment(story).frontmatter).toEqual(storyFrontmatter(story));
    const sparse = { id: '1', name: 'Thing' };
    expect(shortcutEnrichment(sparse).frontmatter).toEqual(storyFrontmatter(sparse));
  });
});
