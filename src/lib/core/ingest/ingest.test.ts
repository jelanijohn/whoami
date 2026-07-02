import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodePlatform } from '../platform-node';
import { RecordStore, provenanceKey } from '../record';
import { findBySource } from '../index-db';
import { RECORD_GITIGNORE } from '../templates';
import type { Platform } from '../types';
import {
  mapGithubGraphqlNode,
  mapGithubCommitNode,
  commitsQuery,
  githubSearchQuery,
  apiBase,
  graphqlUrl,
  selectDiscussion,
  composeDiscussion,
  fetchGithub
} from './github';
import type { Http, HttpRequest, HttpResponse } from '../types';
import {
  mapAsanaTask,
  taskInvolvesMe,
  searchTasksForMe,
  listProjectTasksForMe,
  listAsanaProjects,
  fetchAsana,
  AsanaPaymentRequiredError
} from './asana';
import { mapGmailMessage, internalDateToIso, header } from './gmail';
import {
  parseCsv,
  csvToRecords,
  liDate,
  mapLinkedinPositions,
  importLinkedinArchive
} from './linkedin';
import {
  mapClaudeCodeSession,
  importClaudeCodeSessions,
  claudeCodeRootAllowed,
  CLAUDE_CODE_DEFAULT_PROJECTS
} from './claude-code';
import { rawItemToEntryInput, stageItems } from './pipeline';
import type { RawItem } from './types';

// --- GitHub mapper (GraphQL `search` nodes — see github-graphql-migration.md) -

const GQL_PR = {
  __typename: 'PullRequest',
  databaseId: 9876,
  number: 12,
  title: 'Add provider dispatch',
  url: 'https://github.com/acme/waid/pull/12',
  state: 'MERGED',
  createdAt: '2026-05-20T09:00:00Z',
  closedAt: '2026-06-01T10:00:00Z',
  mergedAt: '2026-06-01T10:00:00Z',
  additions: 123,
  deletions: 45,
  changedFiles: 7,
  repository: { nameWithOwner: 'acme/waid' }
};

const GQL_ISSUE = {
  __typename: 'Issue',
  databaseId: 1,
  number: 3,
  title: 'bug',
  url: 'https://github.com/acme/waid/issues/3',
  state: 'OPEN',
  createdAt: '2026-01-02T00:00:00Z',
  closedAt: null,
  repository: { nameWithOwner: 'acme/waid' }
};

describe('github adapter', () => {
  it('maps a merged PR with change size', () => {
    const item = mapGithubGraphqlNode(GQL_PR);
    expect(item.source).toBe('github');
    expect(item.sourceId).toBe('9876'); // databaseId, the REST numeric id
    expect(item.title).toBe('Add provider dispatch');
    expect(item.url).toBe('https://github.com/acme/waid/pull/12');
    expect(item.date).toBe('2026-06-01'); // closedAt wins
    expect(item.meta?.type).toBe('PR');
    expect(item.meta?.state).toBe('merged'); // MERGED → merged, native
    expect(item.meta?.repo).toBe('acme/waid');
    expect(item.suggestedProject).toBe('acme-waid');
    // Change size rides extraFrontmatter (pass-through) + a body-header line.
    expect(item.extraFrontmatter?.change_size).toEqual({
      additions: 123,
      deletions: 45,
      changed_files: 7
    });
    expect(item.extraFrontmatter?.merged_at).toBe('2026-06-01');
    expect(item.body).toContain('Changes: +123 −45 across 7 files.');
  });

  it('maps a plain issue as Issue, no change size, tolerates missing fields', () => {
    const item = mapGithubGraphqlNode(GQL_ISSUE);
    expect(item.meta?.type).toBe('Issue');
    expect(item.meta?.state).toBe('open'); // OPEN → open
    expect(item.date).toBe('2026-01-02'); // falls back to createdAt
    // Issues carry no change_size and no Changes: line.
    expect(item.extraFrontmatter).toBeUndefined();
    expect(item.body).not.toContain('Changes:');
    expect(mapGithubGraphqlNode({}).sourceId).toBe('');
  });

  it('builds search queries', () => {
    expect(githubSearchQuery({ user: 'jelani' })).toBe('author:jelani');
    expect(
      githubSearchQuery({ user: 'jelani', repo: 'acme/waid', since: '2019-01-01', until: '2019-12-31' })
    ).toBe('author:jelani repo:acme/waid created:2019-01-01..2019-12-31');
    expect(githubSearchQuery({ user: 'j', since: '2019-01-01' })).toBe('author:j created:>=2019-01-01');
    expect(githubSearchQuery({ user: 'j', until: '2020-01-01' })).toBe('author:j created:<=2020-01-01');
  });

  it('derives REST and GraphQL endpoints', () => {
    expect(apiBase()).toBe('https://api.github.com');
    expect(apiBase('https://ghe.corp/')).toBe('https://ghe.corp/api/v3');
    expect(graphqlUrl()).toBe('https://api.github.com/graphql');
    expect(graphqlUrl('https://ghe.corp/')).toBe('https://ghe.corp/api/graphql');
  });

  it('maps the description block when body is present (verbatim)', () => {
    const item = mapGithubGraphqlNode({ ...GQL_PR, body: '  Adds dispatch.\n\nNotes.  ' });
    expect(item.body).toContain('State: merged.');
    expect(item.body).toContain('--- Description ---\nAdds dispatch.\n\nNotes.');
    // Trimmed, and never preceded by leftover whitespace.
    expect(item.body!.endsWith('Notes.')).toBe(true);
  });

  it('omits the description block when body is absent or blank', () => {
    expect(mapGithubGraphqlNode(GQL_PR).body).not.toContain('--- Description ---');
    expect(mapGithubGraphqlNode({ ...GQL_PR, body: '   ' }).body).not.toContain('--- Description ---');
  });
});

// --- GitHub discussion: selectDiscussion (pure, §4) -------------------------

describe('selectDiscussion', () => {
  const raw = {
    issueComments: [
      { user: { login: 'jelani' }, created_at: '2024-01-18T00:00:00Z', body: 'mine, later' },
      { user: { login: 'Reviewer' }, created_at: '2024-01-16T00:00:00Z', body: 'theirs' },
      { user: { login: 'jelani' }, created_at: '2024-01-15T00:00:00Z', body: '  ' } // empty → dropped
    ],
    reviewComments: [
      { user: { login: 'JELANI' }, created_at: '2024-01-14T00:00:00Z', body: 'mine, first' }
    ],
    reviews: [
      { user: { login: 'reviewer' }, submitted_at: '2024-01-17T00:00:00Z', body: 'review summary' },
      { user: { login: 'reviewer' }, submitted_at: '2024-01-19T00:00:00Z', body: '' } // bare approval → dropped
    ]
  };

  it("scope 'self' keeps only the user's non-empty comments, case-insensitive", () => {
    const out = selectDiscussion(raw, 'self', 'jelani');
    expect(out.map((e) => e.body)).toEqual(['mine, first', 'mine, later']); // ascending date
  });

  it("scope 'all' keeps everyone, drops empties, sorts ascending, undated last", () => {
    const withUndated = {
      ...raw,
      issueComments: [...raw.issueComments, { user: { login: 'x' }, body: 'no date' }]
    };
    const out = selectDiscussion(withUndated, 'all', 'jelani');
    expect(out.map((e) => e.body)).toEqual([
      'mine, first', // 01-14
      'theirs', // 01-16
      'review summary', // 01-17
      'mine, later', // 01-18
      'no date' // undated → last
    ]);
    expect(out.at(-1)?.date).toBeUndefined();
  });
});

// --- GitHub discussion: composeDiscussion (pure, §5) ------------------------

describe('composeDiscussion', () => {
  const entries = [
    { author: 'jelani', date: '2024-01-16', body: 'first' },
    { author: 'jelani', date: undefined, body: 'second' }
  ];

  it('renders self vs all line formats', () => {
    expect(composeDiscussion(entries, 'self', 2000)).toBe('[2024-01-16] first\n\n[????-??-??] second');
    expect(composeDiscussion(entries, 'all', 2000)).toBe(
      '[2024-01-16 @jelani] first\n\n[????-??-?? @jelani] second'
    );
  });

  it('returns empty string for no entries', () => {
    expect(composeDiscussion([], 'self', 2000)).toBe('');
  });

  it('leaves under-cap output unchanged', () => {
    const out = composeDiscussion(entries, 'self', 2000);
    expect(out).not.toContain('truncated');
  });

  it('truncates over-cap at a newline with the exact marker, never exceeding cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      author: 'jelani',
      date: '2024-01-16',
      body: `comment number ${i}`
    }));
    const cap = 100;
    const out = composeDiscussion(many, 'self', cap);
    expect(out).toContain(`… [discussion truncated at ${cap} chars]`);
    const marker = '\n… [discussion truncated at';
    const head = out.slice(0, out.indexOf(marker));
    expect(head.length).toBeLessThanOrEqual(cap);
    // The kept head is a verbatim prefix of the full composition (no mangling).
    const full = composeDiscussion(many, 'self', 1_000_000);
    expect(full.startsWith(head)).toBe(true);
  });
});

// --- GitHub fetch path (fake Http, GraphQL listing + REST discussion) -------

/** Route a fake Http by URL substring → canned JSON (or a thrown 500). The
 * GraphQL listing matches `/graphql`; REST discussion endpoints match their
 * path. The method/body are ignored — single-page payloads only. */
function fakeHttp(routes: Array<{ match: string; json?: unknown; status?: number }>): Http {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const route = routes.find((r) => req.url.includes(r.match));
      if (!route) return { status: 404, ok: false, headers: {}, text: 'no route' };
      if (route.status && route.status >= 400) {
        return { status: route.status, ok: false, headers: {}, text: 'boom' };
      }
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(route.json) };
    }
  };
}

/** Wrap search nodes in the GraphQL `search` envelope. */
function gqlSearch(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): unknown {
  return { data: { search: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

describe('fetchGithub with fetchDiscussion', () => {
  const searchNode = {
    __typename: 'PullRequest',
    databaseId: 12,
    number: 12,
    title: 'Add dispatch',
    url: 'https://github.com/acme/waid/pull/12',
    state: 'MERGED',
    createdAt: '2024-01-15T00:00:00Z',
    closedAt: '2024-02-01T00:00:00Z',
    mergedAt: '2024-02-01T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    body: 'Adds dispatch.',
    repository: { nameWithOwner: 'acme/waid' }
  };

  it('appends description + self discussion from the three REST endpoints', async () => {
    const http = fakeHttp([
      { match: '/graphql', json: gqlSearch([searchNode]) },
      {
        match: '/issues/12/comments',
        json: [{ user: { login: 'jelani' }, created_at: '2024-01-16T00:00:00Z', body: 'mine' }]
      },
      {
        match: '/pulls/12/comments',
        json: [{ user: { login: 'other' }, created_at: '2024-01-17T00:00:00Z', body: 'not mine' }]
      },
      {
        match: '/pulls/12/reviews',
        json: [{ user: { login: 'jelani' }, submitted_at: '2024-01-18T00:00:00Z', body: 'lgtm after fix' }]
      }
    ]);
    const items = await fetchGithub(http, { token: 't', user: 'jelani', fetchDiscussion: true });
    expect(items).toHaveLength(1);
    const body = items[0].body!;
    expect(body).toContain('--- Description ---\nAdds dispatch.');
    expect(body).toContain('--- Discussion ---');
    expect(body).toContain('[2024-01-16] mine');
    expect(body).toContain('[2024-01-18] lgtm after fix');
    expect(body).not.toContain('not mine'); // scope 'self' filters out others
  });

  it('keeps the description and completes when a discussion endpoint fails (per-item resilience)', async () => {
    const http = fakeHttp([
      { match: '/graphql', json: gqlSearch([searchNode]) },
      { match: '/issues/12/comments', status: 500 }
    ]);
    const items = await fetchGithub(http, { token: 't', user: 'jelani', fetchDiscussion: true });
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain('--- Description ---\nAdds dispatch.');
    expect(items[0].body).not.toContain('--- Discussion ---');
  });

  it('skips pulls/* endpoints for a non-PR issue', async () => {
    const issueNode = {
      __typename: 'Issue',
      databaseId: 7,
      number: 7,
      title: 'a bug',
      url: 'https://github.com/acme/waid/issues/7',
      state: 'OPEN',
      createdAt: '2024-01-10T00:00:00Z',
      closedAt: null,
      body: 'broken',
      repository: { nameWithOwner: 'acme/waid' }
    };
    const calls: string[] = [];
    const http: Http = {
      async request(req) {
        calls.push(req.url);
        const text = req.url.includes('/graphql')
          ? JSON.stringify(gqlSearch([issueNode]))
          : JSON.stringify([{ user: { login: 'jelani' }, created_at: '2024-01-11T00:00:00Z', body: 'note' }]);
        return { status: 200, ok: true, headers: {}, text };
      }
    };
    const items = await fetchGithub(http, { token: 't', user: 'jelani', fetchDiscussion: true });
    expect(items[0].body).toContain('[2024-01-11] note');
    expect(calls.some((u) => u.includes('/pulls/'))).toBe(false);
    expect(calls.some((u) => u.includes('/issues/7/comments'))).toBe(true);
  });
});

describe('fetchGithub GraphQL listing', () => {
  const node = (n: number) => ({
    __typename: 'PullRequest',
    databaseId: n,
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/waid/pull/${n}`,
    state: 'MERGED',
    createdAt: '2024-01-15T00:00:00Z',
    closedAt: '2024-02-01T00:00:00Z',
    mergedAt: '2024-02-01T00:00:00Z',
    additions: n,
    deletions: 0,
    changedFiles: 1,
    repository: { nameWithOwner: 'acme/waid' }
  });

  it('posts to the GraphQL endpoint with the query in variables, not the URL', async () => {
    let captured: HttpRequest | undefined;
    const http: Http = {
      async request(req) {
        captured = req;
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(gqlSearch([node(1)])) };
      }
    };
    const items = await fetchGithub(http, { token: 't', user: 'jelani', repo: 'acme/waid' });
    expect(items).toHaveLength(1);
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('https://api.github.com/graphql');
    const sent = JSON.parse(captured!.body!);
    expect(sent.variables.q).toBe('author:jelani repo:acme/waid'); // un-encoded qualifier syntax
    expect(captured!.url).not.toContain('author%3A'); // q is NOT in the URL
    // Back-compat: no mode ⇒ the items search query, never the commits query.
    expect(sent.query).toContain('search(query:');
    expect(sent.query).not.toContain('history(author:');
  });

  it('follows the cursor across pages and stops at the cap', async () => {
    const cursors: Array<string | null> = [];
    const http: Http = {
      async request(req) {
        const sent = JSON.parse(req.body!);
        cursors.push(sent.variables.cursor);
        // Page 1: first 100 → hasNextPage. Page 2: remaining → done.
        const page = sent.variables.cursor === null
          ? gqlSearch(Array.from({ length: 100 }, (_, i) => node(i + 1)), true, 'CUR1')
          : gqlSearch(Array.from({ length: 100 }, (_, i) => node(i + 101)), false, null);
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(page) };
      }
    };
    const items = await fetchGithub(http, { token: 't', user: 'jelani', limit: 150 });
    expect(items).toHaveLength(150); // capped, even though 200 were available
    expect(cursors).toEqual([null, 'CUR1']); // followed endCursor on the 2nd call
  });

  it('returns [] for empty results', async () => {
    const http = fakeHttp([{ match: '/graphql', json: gqlSearch([]) }]);
    expect(await fetchGithub(http, { token: 't', user: 'jelani' })).toEqual([]);
  });

  it('surfaces a GraphQL error (HTTP 200 with a top-level errors array)', async () => {
    const http: Http = {
      async request() {
        return {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ errors: [{ message: 'Something went wrong' }], data: null })
        };
      }
    };
    await expect(fetchGithub(http, { token: 't', user: 'jelani' })).rejects.toThrow(
      /GitHub GraphQL error: Something went wrong/
    );
  });
});

// --- GitHub commits: mapGithubCommitNode (pure, commits spec §6) ------------

const GQL_COMMIT = {
  oid: 'abc1234def5678901234567890abcdef12345678',
  messageHeadline: 'Add commit history mode',
  messageBody: 'Resolves the long-standing ask.\n\nDetails follow.',
  authoredDate: '2026-05-20T09:00:00Z',
  committedDate: '2026-05-21T10:00:00Z',
  url: 'https://github.com/acme/waid/commit/abc1234def5678901234567890abcdef12345678',
  additions: 120,
  deletions: 8,
  changedFilesIfAvailable: 4,
  parents: { totalCount: 1 }
};

describe('mapGithubCommitNode', () => {
  it('maps a normal multi-line commit', () => {
    const item = mapGithubCommitNode(GQL_COMMIT, 'acme/waid');
    expect(item.source).toBe('github');
    expect(item.sourceId).toBe(GQL_COMMIT.oid); // full SHA, not databaseId
    expect(item.title).toBe('Add commit history mode'); // == messageHeadline
    expect(item.date).toBe('2026-05-20'); // authoredDate, not committedDate
    expect(item.url).toBe(GQL_COMMIT.url);
    expect(item.suggestedType).toBe('journal');
    expect(item.suggestedTags).toEqual(['github', 'commit']);
    expect(item.suggestedProject).toBe('acme-waid');
    expect(item.meta?.type).toBe('commit');
    expect(item.meta?.repo).toBe('acme/waid');
    expect(item.meta?.parents).toBe('1');
    expect(item.extraFrontmatter?.change_size).toEqual({
      additions: 120,
      deletions: 8,
      changed_files: 4
    });
    expect(item.extraFrontmatter?.commit_sha).toBe(GQL_COMMIT.oid);
    // Body: header lines + the verbatim message block; headline not duplicated.
    expect(item.body).toContain('GitHub commit in acme/waid.');
    expect(item.body).toContain('SHA: abc1234.'); // first 7 of oid
    expect(item.body).toContain('Authored: 2026-05-20.');
    expect(item.body).toContain('Changes: +120 −8 across 4 files.');
    expect(item.body).toContain('--- Message ---\nResolves the long-standing ask.\n\nDetails follow.');
    expect(item.body).not.toContain('Add commit history mode'); // headline only in title
  });

  it('omits the message block when messageBody is empty', () => {
    const item = mapGithubCommitNode({ ...GQL_COMMIT, messageBody: '   ' }, 'acme/waid');
    expect(item.body).not.toContain('--- Message ---');
    expect(item.body).toContain('Changes: +120 −8 across 4 files.');
  });

  it('coerces a null changedFilesIfAvailable to 0', () => {
    const item = mapGithubCommitNode({ ...GQL_COMMIT, changedFilesIfAvailable: null }, 'acme/waid');
    expect((item.extraFrontmatter?.change_size as { changed_files: number }).changed_files).toBe(0);
    expect(item.body).toContain('across 0 files.');
  });

  it('maps a merge commit fine when mapped directly (the filter lives in the loop)', () => {
    const item = mapGithubCommitNode({ ...GQL_COMMIT, parents: { totalCount: 2 } }, 'acme/waid');
    expect(item.meta?.parents).toBe('2');
    expect(item.sourceId).toBe(GQL_COMMIT.oid);
  });
});

describe('commitsQuery', () => {
  it('selects defaultBranchRef when there is no branch', () => {
    const q = commitsQuery(false);
    expect(q).toContain('defaultBranchRef');
    expect(q).not.toContain('ref(');
    expect(q).toContain('changedFilesIfAvailable');
    expect(q).toContain('history(author:');
  });

  it('selects ref(qualifiedName:) when there is a branch', () => {
    const q = commitsQuery(true);
    expect(q).toContain('ref(qualifiedName:');
    expect(q).not.toContain('defaultBranchRef');
    expect(q).toContain('changedFilesIfAvailable');
    expect(q).toContain('history(author:');
  });
});

// --- GitHub commits: fetch path (fake Http, GraphQL history) -----------------

/** A commit history node (sequential SHAs via index so fixtures vary). */
function commitNode(i: number, parents = 1): unknown {
  const oid = String(i).padStart(40, '0');
  return {
    oid,
    messageHeadline: `commit ${i}`,
    messageBody: '',
    authoredDate: '2026-05-20T09:00:00Z',
    committedDate: '2026-05-20T09:00:00Z',
    url: `https://github.com/acme/waid/commit/${oid}`,
    additions: i,
    deletions: 0,
    changedFilesIfAvailable: 1,
    parents: { totalCount: parents }
  };
}

/** Wrap commit nodes in the repository.defaultBranchRef.target.history envelope. */
function gqlHistory(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): unknown {
  return {
    data: {
      repository: {
        defaultBranchRef: { target: { history: { pageInfo: { hasNextPage, endCursor }, nodes } } }
      }
    }
  };
}

/** Route the two-call commit flow: ResolveUser first, then history. */
function commitHttp(history: unknown, user: unknown = { data: { user: { id: 'U_1' } } }): Http {
  let seenResolve = false;
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const sent = JSON.parse(req.body!);
      const isResolve = String(sent.query).includes('ResolveUser');
      const json = isResolve ? user : history;
      if (isResolve) seenResolve = true;
      // History must only be requested after the resolve succeeded.
      if (!isResolve && !seenResolve) return { status: 500, ok: false, headers: {}, text: 'resolve first' };
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(json) };
    }
  };
}

describe('fetchGithub commit mode', () => {
  it('routes to the commits query (not search) and maps each node', async () => {
    let historyQuery = '';
    const http: Http = {
      async request(req) {
        const sent = JSON.parse(req.body!);
        if (String(sent.query).includes('ResolveUser')) {
          return { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: { user: { id: 'U_1' } } }) };
        }
        historyQuery = sent.query;
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(gqlHistory([commitNode(1)])) };
      }
    };
    const items = await fetchGithub(http, { token: 't', user: 'jelani', repo: 'acme/waid', mode: 'commits' });
    expect(items).toHaveLength(1);
    expect(items[0].meta?.type).toBe('commit');
    expect(historyQuery).toContain('history(author:');
    expect(historyQuery).not.toContain('search(query:');
  });

  it('excludes merge commits by default and they do not count toward the cap', async () => {
    const page = gqlHistory([commitNode(1, 1), commitNode(2, 2), commitNode(3, 1)]);
    const dropped = await fetchGithub(commitHttp(page), {
      token: 't',
      user: 'jelani',
      repo: 'acme/waid',
      mode: 'commits'
    });
    expect(dropped).toHaveLength(2); // the 2-parent merge is skipped
    expect(dropped.every((i) => i.meta?.parents === '1')).toBe(true);

    const kept = await fetchGithub(commitHttp(page), {
      token: 't',
      user: 'jelani',
      repo: 'acme/waid',
      mode: 'commits',
      excludeMerges: false
    });
    expect(kept).toHaveLength(3); // merge retained when toggled off
  });

  it('converts date bounds to GitTimestamps and passes null when absent', async () => {
    let vars: Record<string, unknown> = {};
    const http: Http = {
      async request(req) {
        const sent = JSON.parse(req.body!);
        if (String(sent.query).includes('ResolveUser')) {
          return { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: { user: { id: 'U_1' } } }) };
        }
        vars = sent.variables;
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(gqlHistory([])) };
      }
    };
    await fetchGithub(http, {
      token: 't',
      user: 'jelani',
      repo: 'acme/waid',
      mode: 'commits',
      since: '2026-01-01'
    });
    expect(vars.since).toBe('2026-01-01T00:00:00Z');
    expect(vars.until).toBeNull();
  });

  it('throws when the user cannot be resolved', async () => {
    const http = commitHttp(gqlHistory([]), { data: { user: null } });
    await expect(
      fetchGithub(http, { token: 't', user: 'ghost', repo: 'acme/waid', mode: 'commits' })
    ).rejects.toThrow(/couldn't resolve GitHub user/);
  });

  it('throws when the repo is blank', async () => {
    await expect(
      fetchGithub(commitHttp(gqlHistory([])), { token: 't', user: 'jelani', mode: 'commits' })
    ).rejects.toThrow(/commit import needs a repo/);
  });

  it("commit oid and PR databaseId never collide as sourceId under source 'github' (D3)", () => {
    const commit = mapGithubCommitNode(GQL_COMMIT, 'acme/waid');
    const pr = mapGithubGraphqlNode(GQL_PR);
    expect(commit.source).toBe('github');
    expect(pr.source).toBe('github');
    expect(commit.sourceId).not.toBe(pr.sourceId);
    expect(commit.sourceId).toMatch(/^[0-9a-f]{40}$/); // hex SHA
    expect(pr.sourceId).toMatch(/^\d+$/); // decimal databaseId
  });
});

// --- Asana mapper (fixture ported from waid's provider/asana.rs tests) ------

describe('asana mapper', () => {
  it('maps a completed task, surfacing the current assignee', () => {
    const item = mapAsanaTask({
      gid: '12345',
      name: 'Write the spec',
      permalink_url: 'https://app.asana.com/0/12345/12345',
      completed: true,
      completed_at: '2026-06-02T16:00:00.000Z',
      created_at: '2026-05-01T08:00:00.000Z',
      modified_at: '2026-06-02T16:00:00.000Z',
      assignee: { gid: 'u1', name: 'Jelani John' },
      due_on: '2026-06-10',
      memberships: [{ project: { name: 'Roadmap' } }]
    });
    expect(item.sourceId).toBe('12345');
    expect(item.title).toBe('Write the spec');
    expect(item.url).toBe('https://app.asana.com/0/12345/12345');
    expect(item.date).toBe('2026-06-02'); // completed_at wins
    expect(item.meta?.status).toBe('completed');
    expect(item.meta?.project).toBe('Roadmap');
    expect(item.meta?.due).toBe('2026-06-10');
    expect(item.meta?.assignee).toBe('Jelani John'); // "now assigned to X"
    expect(item.body).toContain('Assigned to: Jelani John.');
    expect(item.suggestedProject).toBe('roadmap');
  });

  it('maps an open task with no assignee/project, date falls back to modified_at', () => {
    const item = mapAsanaTask({
      gid: '7',
      name: 'In flight',
      created_at: '2026-05-01T08:00:00.000Z',
      modified_at: '2026-05-09T08:00:00.000Z'
    });
    expect(item.meta?.status).toBe('open');
    expect(item.meta?.assignee).toBeUndefined();
    expect(item.meta?.project).toBeUndefined();
    expect(item.date).toBe('2026-05-09'); // completed_at absent → modified_at
    expect(item.suggestedProject).toBeUndefined();
  });

  it('tolerates missing fields', () => {
    const item = mapAsanaTask({ gid: '9', name: 'bare' });
    expect(item.title).toBe('bare');
    expect(item.date).toBe('');
    expect(item.meta?.status).toBe('open');
    expect(item.suggestedProject).toBeUndefined();
  });

  it('maps the description block when notes are present (verbatim, trimmed)', () => {
    const item = mapAsanaTask({
      gid: '1',
      name: 'has notes',
      notes: '  Built the importer. Handles retries.  '
    });
    expect(item.body).toContain('--- Description ---\nBuilt the importer. Handles retries.');
    // Trimmed: leading/trailing whitespace stripped, body ends at the notes.
    expect(item.body!.endsWith('Built the importer. Handles retries.')).toBe(true);
  });

  it('omits the description block when notes are absent or blank', () => {
    expect(mapAsanaTask({ gid: '1', name: 'no notes' }).body).not.toContain('--- Description ---');
    expect(mapAsanaTask({ gid: '1', name: 'blank notes', notes: '   ' }).body).not.toContain(
      '--- Description ---'
    );
  });

  it('preserves internal newlines under the cap', () => {
    const item = mapAsanaTask({ gid: '1', name: 'multiline', notes: 'Line one.\n\nLine two.' });
    expect(item.body).toContain('--- Description ---\nLine one.\n\nLine two.');
  });

  it('truncates over-cap notes at a word boundary with the exact marker', () => {
    const cap = 500;
    const item = mapAsanaTask({ gid: '1', name: 'long', notes: 'word '.repeat(200) });
    expect(item.body).toContain(`… [description truncated at ${cap} chars]`);
    const start = item.body!.indexOf('--- Description ---\n') + '--- Description ---\n'.length;
    const head = item.body!.slice(start, item.body!.indexOf('\n\n… [description truncated at'));
    expect(head.length).toBeLessThanOrEqual(cap);
    expect('word '.repeat(200).trim().startsWith(head)).toBe(true);
    // Never cut mid-word: the kept head ends on a complete token.
    expect(head.endsWith('word')).toBe(true);
  });
});

// --- Asana involvement predicate (the reassignment-survival signal, §8) -----

describe('taskInvolvesMe', () => {
  it('true when me is the current assignee', () => {
    expect(taskInvolvesMe({ assignee: { gid: 'me' }, followers: [] }, 'me')).toBe(true);
  });

  it('true when me is a follower but NOT the assignee (reassigned-to-reviewer)', () => {
    // The key regression: the task was handed to a reviewer, so `assignee` is
    // someone else, but my prior collaborator membership survives.
    expect(
      taskInvolvesMe({ assignee: { gid: 'reviewer' }, followers: [{ gid: 'me' }, { gid: 'x' }] }, 'me')
    ).toBe(true);
  });

  it('false when me is neither assignee nor follower', () => {
    expect(taskInvolvesMe({ assignee: { gid: 'other' }, followers: [{ gid: 'x' }] }, 'me')).toBe(false);
  });

  it('false (no throw) when followers is missing', () => {
    expect(taskInvolvesMe({ assignee: { gid: 'other' } }, 'me')).toBe(false);
    expect(taskInvolvesMe({}, 'me')).toBe(false);
  });
});

// --- Asana search path: manual created_at.before pagination (§9) ------------

describe('searchTasksForMe', () => {
  const atask = (gid: number, createdAt: string) => ({
    gid: String(gid),
    name: `task ${gid}`,
    created_at: createdAt,
    followers: [{ gid: 'me' }]
  });

  it('walks created_at.before across pages, dedupes timestamp ties, terminates', async () => {
    const befores: Array<string | null> = [];
    const http: Http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const before = new URL(req.url).searchParams.get('created_at.before');
        befores.push(before);
        // Page 1 (no cursor): 100 tasks, oldest is gid 100 @ 2024-01-10.
        // Page 2 (before=2024-01-10…): the boundary task repeats (tie → must
        // dedupe) plus two strictly-older tasks; <100 ⇒ last page.
        const tasks =
          before === null
            ? [
                ...Array.from({ length: 99 }, (_, i) => atask(i + 1, '2024-02-01T00:00:00.000Z')),
                atask(100, '2024-01-10T00:00:00.000Z')
              ]
            : [
                atask(100, '2024-01-10T00:00:00.000Z'),
                atask(101, '2024-01-09T00:00:00.000Z'),
                atask(102, '2024-01-08T00:00:00.000Z')
              ];
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: tasks }) };
      }
    };
    const items = await searchTasksForMe(http, { token: 't', workspace: 'WS', meGid: 'me', limit: 500 });
    expect(items).toHaveLength(102); // 100 + 2 new; the repeated gid 100 deduped
    expect(items.filter((i) => i.sourceId === '100')).toHaveLength(1);
    expect(befores).toEqual([null, '2024-01-10T00:00:00.000Z']); // walked the cursor once
    // Search tasks here have no assignee ⇒ role is collaborator.
    expect(items[0].extraFrontmatter?.asana_role).toBe('collaborator');
  });

  it('throws AsanaPaymentRequiredError on HTTP 402', async () => {
    const http = fakeHttp([{ match: '/tasks/search', status: 402 }]);
    await expect(
      searchTasksForMe(http, { token: 't', workspace: 'WS', meGid: 'me' })
    ).rejects.toBeInstanceOf(AsanaPaymentRequiredError);
  });

  it('scopes the search to one project via projects.any when given a project gid', async () => {
    let captured: string | null = null;
    const http: Http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        captured = new URL(req.url).searchParams.get('projects.any');
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [] }) };
      }
    };
    await searchTasksForMe(http, { token: 't', workspace: 'WS', meGid: 'me', project: 'P1' });
    expect(captured).toBe('P1');
  });
});

// --- Asana project path: dedupe + client-side date filter (§10) -------------

describe('listProjectTasksForMe', () => {
  it('keeps involved tasks, dedupes a gid across projects, drops out-of-range', async () => {
    const http = fakeHttp([
      {
        match: '/workspaces/WS/projects',
        json: { data: [{ gid: 'P1', name: 'Proj1' }, { gid: 'P2', name: 'Proj2' }], next_page: null }
      },
      {
        match: '/projects/P1/tasks',
        json: {
          data: [
            { gid: 'a', name: 'A', followers: [{ gid: 'me' }], created_at: '2024-06-01T00:00:00.000Z' },
            { gid: 's', name: 'Shared', followers: [{ gid: 'me' }], created_at: '2024-06-02T00:00:00.000Z' },
            // not involved → dropped by the predicate
            { gid: 'z', name: 'Theirs', followers: [{ gid: 'other' }], created_at: '2024-06-03T00:00:00.000Z' }
          ],
          next_page: null
        }
      },
      {
        match: '/projects/P2/tasks',
        json: {
          data: [
            // same gid as P1 → deduped across projects
            { gid: 's', name: 'Shared', followers: [{ gid: 'me' }], created_at: '2024-06-02T00:00:00.000Z' },
            // involved but out of range → dropped client-side
            { gid: 'b', name: 'Old', followers: [{ gid: 'me' }], created_at: '2020-01-01T00:00:00.000Z' }
          ],
          next_page: null
        }
      }
    ]);
    const items = await listProjectTasksForMe(http, {
      token: 't',
      workspace: 'WS',
      meGid: 'me',
      since: '2024-01-01',
      until: '2024-12-31'
    });
    expect(items.map((i) => i.sourceId).sort()).toEqual(['a', 's']);
  });

  it('with a project gid, skips enumeration and fetches only that project', async () => {
    // No '/workspaces/WS/projects' route: if enumeration ran it would 404 and
    // throw, so a clean result proves the single-project shortcut was taken.
    const http = fakeHttp([
      {
        match: '/projects/P1/tasks',
        json: {
          data: [{ gid: 'a', name: 'A', followers: [{ gid: 'me' }], created_at: '2024-06-01T00:00:00.000Z' }],
          next_page: null
        }
      }
    ]);
    const items = await listProjectTasksForMe(http, {
      token: 't',
      workspace: 'WS',
      meGid: 'me',
      project: 'P1'
    });
    expect(items.map((i) => i.sourceId)).toEqual(['a']);
  });
});

// --- Asana project picker: list workspace projects, sorted ------------------

describe('listAsanaProjects', () => {
  it('lists the workspace projects (gid + name), sorted by name', async () => {
    const http = fakeHttp([
      {
        match: '/workspaces/WS/projects',
        json: { data: [{ gid: 'P2', name: 'Beta' }, { gid: 'P1', name: 'Alpha' }], next_page: null }
      }
    ]);
    const projects = await listAsanaProjects(http, { token: 't', workspace: 'WS' });
    expect(projects).toEqual([
      { gid: 'P1', name: 'Alpha' },
      { gid: 'P2', name: 'Beta' }
    ]);
  });
});

// --- Asana orchestrator: auto fallback on 402 (§3, §11) ---------------------

describe('fetchAsana auto fallback', () => {
  it('routes to the project path when search returns 402', async () => {
    const http = fakeHttp([
      { match: '/tasks/search', status: 402 },
      { match: '/workspaces/WS/projects', json: { data: [{ gid: 'P1', name: 'P' }], next_page: null } },
      {
        match: '/projects/P1/tasks',
        json: {
          data: [{ gid: 'x', name: 'X', followers: [{ gid: 'me' }], created_at: '2024-06-01T00:00:00.000Z' }],
          next_page: null
        }
      }
    ]);
    const items = await fetchAsana(http, { token: 't', workspace: 'WS', meGid: 'me' });
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe('x');
  });
});

// --- Gmail mapper (fixtures ported from waid's provider/gmail.rs tests) -----

const GMAIL_MSG = {
  id: '18f0a1b2c3d4e5f6',
  labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
  internalDate: '1717372800000',
  snippet: '  Hey — wanted to check in on the redesign timeline before Friday.  ',
  payload: {
    headers: [
      { name: 'Delivered-To', value: 'me@acme.com' },
      { name: 'From', value: 'Dana Lee <dana@acme.com>' },
      { name: 'Subject', value: 'Acme redesign — timeline' },
      { name: 'Date', value: 'Mon, 03 Jun 2024 00:00:00 +0000' }
    ]
  }
};

describe('gmail adapter', () => {
  it('parses internalDate (epoch-ms string) to ISO', () => {
    // 1717372800000 ms = 2024-06-03T00:00:00Z (waid's fixture).
    expect(internalDateToIso('1717372800000')).toBe('2024-06-03T00:00:00.000Z');
    expect(internalDateToIso('not-a-number')).toBeUndefined();
    expect(internalDateToIso(undefined)).toBeUndefined();
  });

  it('looks up headers case-insensitively', () => {
    expect(header(GMAIL_MSG, 'subject')).toBe('Acme redesign — timeline');
    expect(header(GMAIL_MSG, 'FROM')).toBe('Dana Lee <dana@acme.com>');
    expect(header({}, 'Subject')).toBeUndefined();
  });

  it('maps a message', () => {
    const item = mapGmailMessage(GMAIL_MSG);
    expect(item.sourceId).toBe('18f0a1b2c3d4e5f6');
    expect(item.title).toBe('Acme redesign — timeline');
    expect(item.url).toBe('https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6');
    expect(item.date).toBe('2024-06-03');
    expect(item.meta?.from).toBe('Dana Lee <dana@acme.com>');
    expect(item.body).toContain('redesign timeline before Friday.');
  });

  it('tolerates a bare message', () => {
    const item = mapGmailMessage({ id: 'abc', internalDate: '1717372800000' });
    expect(item.title).toBe('(no subject)');
    expect(item.date).toBe('2024-06-03');
    expect(item.meta?.from).toBeUndefined();
  });
});

// --- LinkedIn archive import -------------------------------------------------

describe('linkedin import', () => {
  it('parses RFC-4180 CSV with quotes, embedded commas and newlines', () => {
    const csv = 'a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\nplain,2,3\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
      ['plain', '2', '3']
    ]);
    const recs = csvToRecords(csv);
    expect(recs[0]['a']).toBe('x, y');
    expect(recs[1]['c']).toBe('3');
  });

  it('parses LinkedIn-style dates', () => {
    expect(liDate('Mar 2019')).toBe('2019-03-01');
    expect(liDate('2019')).toBe('2019-01-01');
    expect(liDate('2019-07-15')).toBe('2019-07-15');
    expect(liDate('Sep 2021')).toBe('2021-09-01');
    expect(liDate('')).toBeUndefined();
    expect(liDate('garbage')).toBeUndefined();
  });

  it('maps Positions.csv rows to role items and skips date-less rows', () => {
    const csv = [
      'Company Name,Title,Description,Location,Started On,Finished On',
      '"Bloomberg L.P.","Software Engineer","Built ""terminal"" infra, etc.","New York, NY",Mar 2019,Sep 2021',
      'NoDate Inc,Engineer,,,,'
    ].join('\n');
    const items = mapLinkedinPositions(csv);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.source).toBe('linkedin');
    expect(it0.suggestedType).toBe('role');
    expect(it0.title).toBe('Software Engineer — Bloomberg L.P.');
    expect(it0.date).toBe('2019-03-01');
    expect(it0.extraFrontmatter?.org).toBe('Bloomberg L.P.');
    expect(it0.extraFrontmatter?.end).toBe('2021-09-01');
    expect(it0.body).toContain('Built "terminal" infra');
    // Deterministic source id → re-import dedupes.
    expect(it0.sourceId).toBe(mapLinkedinPositions(csv)[0].sourceId);
  });

  it('dispatches archive files by basename', () => {
    const files = {
      'Positions.csv':
        'Company Name,Title,Description,Location,Started On,Finished On\nAcme,Dev,,,Jan 2020,',
      'somefolder/Education.csv':
        'School Name,Start Date,End Date,Notes,Degree Name,Activities\nMIT,Sep 2014,Jun 2018,,BSc,',
      'Ignored.csv': 'a,b\n1,2'
    };
    const items = importLinkedinArchive(files);
    expect(items.map((i) => i.suggestedType).sort()).toEqual(['education', 'role']);
  });
});

// --- Claude Code adapter (session JSONL → RawItem) ----------------------------

describe('claude-code adapter', () => {
  const CWD = '/root/Projects/whoami';
  const SID = '60b1112b-3dc2-442b-9fc6-8ad567eff6e8';
  // Provenance fields that ride every real message line.
  const prov = (ts: string) => ({ sessionId: SID, cwd: CWD, gitBranch: 'main', slug: 'modular-jumping-lamport', timestamp: ts });
  const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  // A faithfully-trimmed real edit session (spec §10): caveat + /clear + one
  // typed turn → grep/read/read/Edit arc → Edit tool_result with structuredPatch
  // → repeated ai-title → turn_duration → away_summary.
  const editSession = () =>
    jsonl(
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat: messages below were generated by the user while running local commands. DO NOT respond.</local-command-caveat>' }, ...prov('2026-06-14T20:15:00.000Z') },
      { type: 'user', message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' }, ...prov('2026-06-14T20:15:30.000Z') },
      { type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>', ...prov('2026-06-14T20:15:31.000Z') },
      { type: 'user', promptSource: 'typed', message: { content: "There's an error. After selecting mutiple items in the Inbox and promoting them, the info bar showing te number of selected items does not go away." }, ...prov('2026-06-14T20:16:33.824Z') },
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rg foo' } }] }, ...prov('2026-06-14T20:16:40.000Z') },
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${CWD}/src/routes/inbox/+page.svelte` } }] }, ...prov('2026-06-14T20:16:45.000Z') },
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'I see the bug — the selection set is never cleared.' }] }, ...prov('2026-06-14T20:16:50.000Z') },
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${CWD}/src/routes/inbox/+page.svelte` } }] }, ...prov('2026-06-14T20:16:55.000Z') },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
        toolUseResult: {
          filePath: `${CWD}/src/routes/inbox/+page.svelte`,
          structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 5, lines: ['-  selected = old;', '+  selected = new();', '+  bar = false;', '+  refresh();', '+  done();', '   return;'] }]
        },
        ...prov('2026-06-14T20:17:00.000Z')
      },
      { type: 'ai-title', aiTitle: 'Fix info bar', ...prov('2026-06-14T20:17:01.000Z') },
      { type: 'ai-title', aiTitle: 'Fix info bar after promoting selected items', ...prov('2026-06-14T20:17:30.000Z') },
      { type: 'system', subtype: 'turn_duration', durationMs: 36965, messageCount: 22, ...prov('2026-06-14T20:17:31.000Z') },
      { type: 'system', subtype: 'away_summary', content: 'Fixed the Inbox bug where the info bar lingered.\nNext, verify it in the app.', ...prov('2026-06-14T20:17:32.000Z') }
    );

  it('maps a real edit session to a candidate with grounded features', () => {
    const item = mapClaudeCodeSession(editSession(), `/root/.claude/projects/-root-Projects-whoami/${SID}.jsonl`)!;
    expect(item).not.toBeNull();
    expect(item.source).toBe('claude-code');
    expect(item.sourceId).toBe(SID);
    expect(item.date).toBe('2026-06-14'); // first genuine turn's day, not the /clear above it
    expect(item.suggestedType).toBe('journal');
    expect(item.suggestedProject).toBe('whoami');
    expect(item.suggestedTags).toEqual(['claude-code']); // branch is main → no extra tag
    expect(item.title).toBe('Fix info bar after promoting selected items'); // last ai-title wins

    // body = the typed prompt verbatim (typos and all), excluding everything else.
    expect(item.body).toContain('selecting mutiple items'); // raw typo preserved
    expect(item.body).not.toContain('local-command-caveat');
    expect(item.body).not.toContain('/clear');
    expect(item.body).not.toContain('I see the bug'); // assistant text excluded
    expect(item.body).not.toContain('tool_result');

    const f = item.extraFrontmatter!;
    expect(f.cc_session_id).toBe(SID);
    expect(f.cc_turns_user).toBe(1);
    expect(f.cc_turns_assistant).toBe(4);
    expect(f.cc_authorship).toBe(0.2); // 1 / (1 + 4)
    expect(f.cc_tools).toEqual(['Bash', 'Edit', 'Read']); // deduped + sorted
    expect(f.cc_files_touched).toEqual(['src/routes/inbox/+page.svelte']); // Edit only, repo-relative; Read excluded
    expect(f.cc_lines_added).toBe(4);
    expect(f.cc_lines_removed).toBe(1);
    expect(f.cc_files_edited).toBe(1);
    expect(f.cc_models).toEqual(['claude-opus-4-8']);
    expect(f.cc_git_branch).toBe('main');
    expect(f.cc_cwd).toBe(CWD);
    expect(f.cc_active_min).toBeCloseTo(0.6, 1); // 36965ms
    expect(f.cc_started_at).toBe('2026-06-14T20:16:33.824Z');
  });

  it('returns null for a /clear→/exit junk session with zero genuine turns', () => {
    const junk = jsonl(
      { type: 'mode', ...prov('2026-06-13T08:00:00.000Z') },
      { type: 'file-history-snapshot', ...prov('2026-06-13T08:00:01.000Z') },
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>noise</local-command-caveat>' }, ...prov('2026-06-13T08:00:02.000Z') },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' }, ...prov('2026-06-13T08:00:03.000Z') },
      { type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>', ...prov('2026-06-13T08:00:04.000Z') },
      { type: 'last-prompt', ...prov('2026-06-13T08:00:05.000Z') }
    );
    expect(mapClaudeCodeSession(junk)).toBeNull();
  });

  it('returns null for a summary-only session (no genuine human turn)', () => {
    const summaryOnly = jsonl(
      { type: 'ai-title', aiTitle: 'Some title', ...prov('2026-06-13T08:00:00.000Z') },
      { type: 'system', subtype: 'away_summary', content: 'A recap.', ...prov('2026-06-13T08:00:01.000Z') }
    );
    expect(mapClaudeCodeSession(summaryOnly)).toBeNull();
  });

  it('excludes subagent (sidechain) and array-content user lines from the body', () => {
    const s = jsonl(
      { type: 'user', isSidechain: true, message: { content: 'subagent internal prompt' }, ...prov('2026-06-14T10:00:00.000Z') },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'echoed output' }] }, ...prov('2026-06-14T10:00:01.000Z') },
      { type: 'user', promptSource: 'typed', message: { content: 'my real question' }, ...prov('2026-06-14T10:00:02.000Z') }
    );
    const item = mapClaudeCodeSession(s)!;
    expect(item.body).toBe('my real question');
    expect(item.extraFrontmatter!.cc_turns_user).toBe(1);
  });

  it('skips a corrupt line without throwing', () => {
    const withGarbage = 'not json at all\n' + editSession();
    const item = mapClaudeCodeSession(withGarbage, `/x/${SID}.jsonl`)!;
    expect(item.sourceId).toBe(SID);
    expect(item.extraFrontmatter!.cc_turns_user).toBe(1);
  });

  it('falls back to filePath for sessionId and project when cwd is absent', () => {
    const noCwd = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: 'a question in waid' }, timestamp: '2026-06-12T09:00:00.000Z' }
    );
    const item = mapClaudeCodeSession(noCwd, '/root/.claude/projects/-root-Projects-waid/abc-123.jsonl')!;
    expect(item.sourceId).toBe('abc-123');
    expect(item.suggestedProject).toBe('waid');
    expect(item.extraFrontmatter!.cc_cwd).toBeUndefined();
  });

  it('tags a non-default git branch', () => {
    const s = jsonl(
      { type: 'user', promptSource: 'typed', message: { content: 'feature work' }, ...prov('2026-06-14T11:00:00.000Z'), gitBranch: 'feat/new-thing' }
    );
    const item = mapClaudeCodeSession(s)!;
    expect(item.suggestedTags).toEqual(['claude-code', 'feat-new-thing']);
  });

  it('scopes import to the allowed project roots (spec §7)', () => {
    const allow = CLAUDE_CODE_DEFAULT_PROJECTS;
    expect(claudeCodeRootAllowed('-root-Projects-whoami', allow)).toBe(true);
    expect(claudeCodeRootAllowed('-Users-jelani-code-waid', allow)).toBe(true); // portable across home paths
    expect(claudeCodeRootAllowed('waid', allow)).toBe(true); // bare name
    expect(claudeCodeRootAllowed('-root-Projects-glue', allow)).toBe(false);
    expect(claudeCodeRootAllowed('-root-Projects-blapp-web', allow)).toBe(false);
    expect(claudeCodeRootAllowed('memory', allow)).toBe(false);
  });

  it('imports many sessions and drops the genuine-turn-less ones', () => {
    const files = {
      [`/p/${SID}.jsonl`]: editSession(),
      '/p/junk.jsonl': jsonl({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, timestamp: '2026-06-13T08:00:03.000Z' }),
      '/p/corrupt.jsonl': '{ broken'
    };
    const items = importClaudeCodeSessions(files);
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe(SID);
  });
});

// --- Pipeline round-trip ------------------------------------------------------

describe('staging pipeline', () => {
  let root: string;
  let platform: Platform;
  let store: RecordStore;

  const item = (n: number): RawItem => ({
    source: 'github',
    sourceId: `id-${n}`,
    title: `Item ${n}`,
    date: '2026-01-0' + n,
    url: `https://github.com/acme/waid/pull/${n}`,
    body: `Body ${n}`,
    suggestedType: 'journal',
    suggestedTags: ['github'],
    suggestedProject: 'acme-waid'
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'whoami-ingest-'));
    platform = createNodePlatform(':memory:');
    store = new RecordStore(platform, root);
    await store.init();
  });

  afterEach(async () => {
    await platform.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('maps RawItem → entry input with provenance, privacy, and project', () => {
    const input = rawItemToEntryInput(item(1), '2026-06-10T00:00:00.000Z');
    expect(input.private).toBe(true);
    expect(input.extra?.source).toBe('github');
    expect(input.extra?.source_id).toBe('id-1');
    expect(input.extra?.reviewed).toBe(false);
    expect(input.extra?.project).toBe('acme-waid');
    expect(input.extra?.links).toEqual(['https://github.com/acme/waid/pull/1']);
    expect(input.extra?.ingested_at).toBe('2026-06-10T00:00:00.000Z');
  });

  it('honors the private override (default true, opt-out false)', async () => {
    // The pure mapper: priv arg overrides the protective default.
    expect(rawItemToEntryInput(item(1)).private).toBe(true);
    expect(rawItemToEntryInput(item(1), undefined, undefined, false).private).toBe(false);

    // stageItems threads it onto the staged candidates.
    await stageItems(store, [item(1)], { private: false });
    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].frontmatter.private).toBe(false);
  });

  it('honors the import-time project override (wins over suggestedProject)', async () => {
    // The pure mapper: a non-empty override replaces the adapter's suggestion;
    // blank/whitespace falls back to it.
    expect(rawItemToEntryInput(item(1)).extra?.project).toBe('acme-waid');
    expect(rawItemToEntryInput(item(1), undefined, undefined, true, 'big-rewrite').extra?.project).toBe(
      'big-rewrite'
    );
    expect(rawItemToEntryInput(item(1), undefined, undefined, true, '  ').extra?.project).toBe('acme-waid');

    // stageItems threads it onto every staged candidate.
    await stageItems(store, [item(1)], { project: 'big-rewrite' });
    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].frontmatter.project).toBe('big-rewrite');
  });

  it('stages, dedupes, promotes, and rejects', async () => {
    // First run: both staged.
    const r1 = await stageItems(store, [item(1), item(2)]);
    expect(r1).toMatchObject({ fetched: 2, staged: 2, skippedPromoted: 0, skippedRejected: 0 });
    let candidates = await store.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.frontmatter.private === true)).toBe(true);

    // Re-run: idempotent (deterministic filenames → still 2 candidates).
    await stageItems(store, [item(1), item(2)]);
    expect(await store.listCandidates()).toHaveLength(2);

    // Promote item 1 → it becomes a real entry with a provenance row.
    candidates = await store.listCandidates();
    const cand1 = candidates.find((c) => c.frontmatter.source_id === 'id-1')!;
    const promoted = await store.promoteCandidate(cand1.path!);
    expect(promoted.path!.startsWith('entries/')).toBe(true);
    expect(await findBySource(platform.db, 'github', 'id-1')).toBe(promoted.frontmatter.id);
    expect(await store.listCandidates()).toHaveLength(1);

    // Promoted entries are private and excluded from outputs by default.
    expect(await store.listEntries()).toHaveLength(0);
    expect(await store.listEntries({ includePrivate: true })).toHaveLength(1);

    // Reject item 2 → remembered in rejected.tsv, file gone.
    const cand2 = (await store.listCandidates())[0];
    await store.rejectCandidate(cand2.path!);
    expect(await store.listCandidates()).toHaveLength(0);
    expect((await store.rejectedKeys()).has(provenanceKey('github', 'id-2'))).toBe(true);

    // Third run: nothing restages — one already promoted, one rejected.
    const r3 = await stageItems(store, [item(1), item(2)]);
    expect(r3).toMatchObject({ fetched: 2, staged: 0, skippedPromoted: 1, skippedRejected: 1 });
    expect(await store.listCandidates()).toHaveLength(0);
  });

  it('needs_date item stages with empty date (allow-undated spec §B)', async () => {
    const undated: RawItem = {
      source: 'resume',
      sourceId: 'role:acme::intern:',
      title: 'Intern — Acme',
      date: '',
      body: 'Built the billing service from scratch.',
      suggestedType: 'role',
      suggestedTags: ['resume'],
      extraFrontmatter: { needs_date: true }
    };
    const report = await stageItems(store, [undated]);
    expect(report.staged).toBe(1);
    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].frontmatter.date).toBe('');
    expect(candidates[0].frontmatter.needs_date).toBe(true);
  });

  it('dated item still defaults to today when date is empty (regression)', () => {
    const input = rawItemToEntryInput({ ...item(1), date: '' });
    // No needs_date marker ⇒ empty date collapses to undefined, makeEntry
    // stamps today — byte-for-byte the prior behavior.
    expect(input.date).toBeUndefined();
  });

  it('survives bad items without aborting the batch', async () => {
    const bad: RawItem = { source: 'github', sourceId: '', title: 'no id', date: '2026-01-01' };
    const r = await stageItems(store, [bad, item(3)]);
    expect(r.staged).toBe(1);
    expect(r.errors).toHaveLength(1);
  });

  it('stages a shortcut story candidate round-trip (story-import spec T11)', async () => {
    const story: RawItem = {
      source: 'shortcut',
      sourceId: '57886',
      title: 'Promo banner disclaimer',
      date: '2026-05-20',
      url: 'https://app.shortcut.com/acme/story/57886',
      body: '--- Description ---\nAdd the legal disclaimer under the promo banner.',
      suggestedType: 'journal',
      suggestedTags: ['shortcut', 'feature'],
      extraFrontmatter: { shortcut: { id: '57886', type: 'feature', roles: ['owner', 'follower'] } }
    };
    const r1 = await stageItems(store, [story]);
    expect(r1).toMatchObject({ fetched: 1, staged: 1 });
    const [cand] = await store.listCandidates();
    // Provenance keys, protective privacy default, and the shared shortcut
    // frontmatter (the Stage-2 join key) all survive the text round-trip.
    expect(cand.frontmatter.source).toBe('shortcut');
    expect(cand.frontmatter.source_id).toBe('57886');
    expect(cand.frontmatter.private).toBe(true);
    expect(cand.frontmatter.shortcut).toEqual({
      id: '57886',
      type: 'feature',
      roles: ['owner', 'follower']
    });
    // No shortcut_ids — a story item must never trigger self-enrichment (§4.6).
    expect(cand.frontmatter.shortcut_ids).toBeUndefined();

    // Promote, then re-run: idempotence via selectNewItems — 0 staged.
    await store.promoteCandidate(cand.path!, { project: '' });
    const r2 = await stageItems(store, [story]);
    expect(r2).toMatchObject({ staged: 0, skippedPromoted: 1 });
    expect(await store.listCandidates()).toHaveLength(0);
  });

  it('full rebuild repopulates provenance from text', async () => {
    await stageItems(store, [item(1)]);
    const cand = (await store.listCandidates())[0];
    const promoted = await store.promoteCandidate(cand.path!);
    await store.fullRebuild();
    expect(await findBySource(platform.db, 'github', 'id-1')).toBe(promoted.frontmatter.id);
  });

  it('keeps the inbox out of version control', () => {
    expect(RECORD_GITIGNORE).toContain('.inbox/');
  });
});
