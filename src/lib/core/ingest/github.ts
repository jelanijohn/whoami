/**
 * GitHub adapter — port of waid's `provider/github.rs`, reoriented for a
 * historical record: instead of "open issues assigned to me now", it pulls
 * issues & PRs **authored by a user inside a date range**, which is exactly the
 * Phase-1 "reconstruct a period" query.
 *
 * The listing runs over the **GraphQL** `search` connection (POST /graphql), so
 * per-PR change size (`additions`/`deletions`/`changedFiles`) folds into the
 * same call — no N+1 against the REST `/repos/{}/pulls/{}` endpoint. See
 * `docs/github-graphql-migration.md`. The optional discussion fetch still uses
 * the REST endpoints per item (Phase 2 would fold it into GraphQL too).
 *
 * `mapGithubGraphqlNode` is pure and fixture-tested. Network happens only
 * through the Http seam; the token is passed in ready (never loaded here).
 */

import type { Http } from '../types';
import { slugify } from '../ids';
import { bearer, getJson, postJson } from './http';
import { asNum, asStr, get, isoDate, type RawItem } from './types';
import { DEFAULT_SHORTCUT_REF, extractShortcutRefs } from './shortcut';

const DEFAULT_API = 'https://api.github.com';

export interface GithubFetchOpts {
  token: string;
  /** GitHub login whose authored issues/PRs to pull. */
  user: string;
  /** Restrict to one repo, `owner/name`. Also drives `suggestedProject`. */
  repo?: string;
  /** Created-date bounds, YYYY-MM-DD (inclusive). */
  since?: string;
  until?: string;
  /** Total cap across pages. Default 50, max 300. */
  limit?: number;
  /** GitHub Enterprise base URL (`https://ghe.corp` → `…/api/v3`). */
  baseUrl?: string;

  /** Fetch issue/PR discussion (comments, review comments, review summaries)
   *  in addition to the description. Adds up to 3 REST calls per PR, 1 per
   *  issue. Default false — description-only keeps imports cheap. */
  fetchDiscussion?: boolean;

  /** Whose comments to include when fetchDiscussion is on.
   *  'self' (default) = only comments authored by `user`;
   *  'all'            = everyone's, attributed by login. */
  commentScope?: 'self' | 'all';

  /** Char cap on the composed **discussion** section, per item. Default 2000.
   *  The description (change A) is NEVER capped by this. */
  discussionCharCap?: number;

  /** 'items' (default) = authored issues & PRs (today's path). 'commits' =
   *  authored commits on one repo's branch (D1–D6). */
  mode?: 'items' | 'commits';
  /** Commit mode only: branch to read history from. Blank ⇒ the default branch. */
  branch?: string;
  /** Commit mode only: drop merge commits (parents > 1). Default true (D5). */
  excludeMerges?: boolean;

  /** Shortcut ticket-reference pattern (regex source) the mappers extract with
   *  (shortcut-enrichment spec D5). Omitted ⇒ {@link DEFAULT_SHORTCUT_REF}.
   *  Extraction is always-on, deterministic, and token-free. */
  shortcutRefPattern?: string;
}

export const DEFAULT_COMMENT_SCOPE: 'self' | 'all' = 'self';
export const DEFAULT_DISCUSSION_CHAR_CAP = 2000;

/** REST API base: api.github.com, or `{base}/api/v3` for Enterprise. Still used
 * by `validateGithub` and the (REST) discussion fetch. */
export function apiBase(baseUrl?: string): string {
  const b = baseUrl?.trim().replace(/\/+$/, '');
  return b ? `${b}/api/v3` : DEFAULT_API;
}

/** GraphQL endpoint: api.github.com/graphql, or `{base}/api/graphql` for
 * Enterprise (note: `/api/graphql`, NOT `/api/v3`). */
export function graphqlUrl(baseUrl?: string): string {
  const b = baseUrl?.trim().replace(/\/+$/, '');
  return b ? `${b}/api/graphql` : `${DEFAULT_API}/graphql`;
}

/** Build the search query string (pure — unit-tested). The qualifier syntax is
 * identical between REST `/search/issues` and GraphQL `search(query:)`, so this
 * is reused verbatim — it goes in GraphQL `variables`, never a URL, so it is
 * NOT percent-encoded. */
export function githubSearchQuery(o: Pick<GithubFetchOpts, 'user' | 'repo' | 'since' | 'until'>): string {
  const parts = [`author:${o.user}`];
  if (o.repo) parts.push(`repo:${o.repo}`);
  if (o.since && o.until) parts.push(`created:${o.since}..${o.until}`);
  else if (o.since) parts.push(`created:>=${o.since}`);
  else if (o.until) parts.push(`created:<=${o.until}`);
  return parts.join(' ');
}

/** The authored-items GraphQL query. `type: ISSUE` returns both issues and PRs
 * (matching REST `/search/issues`), discriminated by `__typename`. PR nodes
 * additionally carry `mergedAt` and the change-size scalars — a flat list that
 * costs ~1 point/page against the 5,000 points/hour budget. */
const AUTHORED_ITEMS_QUERY = `query AuthoredItems($q: String!, $first: Int!, $cursor: String) {
  search(query: $q, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        databaseId number title body url state createdAt closedAt
        repository { nameWithOwner }
      }
      ... on PullRequest {
        databaseId number title body url state createdAt closedAt mergedAt
        additions deletions changedFiles
        repository { nameWithOwner }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

/** Map one GraphQL `search` node (Issue or PullRequest) into a RawItem. Pure —
 * fixture-tested. Output is byte-identical to the old REST mapper for every
 * shared field; change size is purely additive (PR nodes only). */
export function mapGithubGraphqlNode(node: unknown, refPattern = DEFAULT_SHORTCUT_REF): RawItem {
  const isPr = asStr(get(node, '__typename')) === 'PullRequest';
  const repo = asStr(get(node, 'repository', 'nameWithOwner'));
  // GraphQL state is upper-case (OPEN | CLOSED | MERGED); lower-case it to match
  // the REST-era values. MERGED is now native — no second field to inspect.
  const state = (asStr(get(node, 'state')) ?? '').toLowerCase();
  const created = isoDate(get(node, 'createdAt'));
  const closed = isoDate(get(node, 'closedAt'));

  const type = isPr ? 'PR' : 'Issue';
  const meta: Record<string, string> = { type };
  if (repo) meta.repo = repo;
  if (state) meta.state = state;

  const bodyLines = [
    `GitHub ${type}${repo ? ` in ${repo}` : ''}.`,
    `State: ${state || 'unknown'}.`,
    created ? `Opened: ${created}.` : '',
    closed ? `Closed: ${closed}.` : ''
  ];

  // Change size (PR nodes only). These are our own computed facts (not verbatim
  // external text), so they ride both an extraFrontmatter pass-through and a
  // body-header line — unlike the `--- Description ---` block, which stays
  // verbatim provider data.
  const extraFrontmatter: Record<string, unknown> = {};
  if (isPr) {
    const additions = asNum(get(node, 'additions')) ?? 0;
    const deletions = asNum(get(node, 'deletions')) ?? 0;
    const changedFiles = asNum(get(node, 'changedFiles')) ?? 0;
    extraFrontmatter.change_size = { additions, deletions, changed_files: changedFiles };
    bodyLines.push(`Changes: +${additions} −${deletions} across ${changedFiles} files.`);
    // mergedAt is a truer "done" date than closedAt for merged PRs (§12); cheap,
    // rides the same pass-through. Only present on merged PRs.
    const mergedAt = isoDate(get(node, 'mergedAt'));
    if (mergedAt) extraFrontmatter.merged_at = mergedAt;
  }

  let body = bodyLines.filter(Boolean).join('\n');
  const desc = asStr(get(node, 'body'))?.trim();
  if (desc) body += `\n\n--- Description ---\n${desc}`;

  const title = asStr(get(node, 'title')) ?? '';
  // Shortcut ticket refs (shortcut-enrichment spec §2.2): real provenance, so
  // they persist to the candidate and into the record on promote. The first id
  // also rides string-valued `meta` for prefilter/cluster rules. No ref ⇒
  // neither key, keeping ref-free output byte-identical to before.
  const refs = extractShortcutRefs(`${title}\n${body}`, refPattern);
  if (refs.length > 0) {
    extraFrontmatter.shortcut_ids = refs;
    meta.shortcut_id = refs[0];
  }

  // MUST be databaseId, not the node `id`: databaseId equals the REST numeric id
  // every promoted/rejected item was deduped against — using the base64 node id
  // would silently re-propose handled items.
  const dbId = get(node, 'databaseId');

  return {
    source: 'github',
    sourceId: dbId !== undefined && dbId !== null ? String(dbId) : '',
    title,
    // The event date: when work concluded if it did, else when it started.
    date: closed ?? created ?? '',
    url: asStr(get(node, 'url')),
    body,
    suggestedType: 'journal',
    suggestedTags: ['github'],
    suggestedProject: repo ? slugify(repo) : undefined,
    meta,
    ...(Object.keys(extraFrontmatter).length ? { extraFrontmatter } : {})
  };
}

/** Map one GraphQL commit `history` node into a RawItem. Pure — fixture-tested.
 * The commit node carries no repository, so `repo` (`owner/name`) is passed in
 * from opts. Imports metadata + the verbatim message + change-size counts only;
 * NEVER the diff (commits spec §1.2, D4). */
export function mapGithubCommitNode(node: unknown, repo: string, refPattern = DEFAULT_SHORTCUT_REF): RawItem {
  const oid = asStr(get(node, 'oid')) ?? '';
  const headline = asStr(get(node, 'messageHeadline')) ?? '';
  const date = isoDate(get(node, 'authoredDate')) ?? '';
  const additions = asNum(get(node, 'additions')) ?? 0;
  const deletions = asNum(get(node, 'deletions')) ?? 0;
  const changedFiles = asNum(get(node, 'changedFilesIfAvailable')) ?? 0;
  const parents = asNum(get(node, 'parents', 'totalCount')) ?? 0;

  // Mirrors the PR body idiom (filter(Boolean).join('\n')); these are our own
  // computed facts, not verbatim provider text.
  let body = [
    `GitHub commit in ${repo}.`,
    `SHA: ${oid.slice(0, 7)}.`,
    `Authored: ${date}.`,
    `Changes: +${additions} −${deletions} across ${changedFiles} files.`
  ]
    .filter(Boolean)
    .join('\n');
  // The verbatim message body rides as a fenced block — the headline is already
  // the title, so it is not duplicated here.
  const message = asStr(get(node, 'messageBody'))?.trim();
  if (message) body += `\n\n--- Message ---\n${message}`;

  const meta: Record<string, string> = { type: 'commit', repo, parents: String(parents) };
  const extraFrontmatter: Record<string, unknown> = {
    change_size: { additions, deletions, changed_files: changedFiles },
    commit_sha: oid
  };
  // Shortcut ticket refs (shortcut-enrichment spec §2.2) — same idiom as the
  // items mapper: provenance in extraFrontmatter, first id in string meta.
  const refs = extractShortcutRefs(`${headline}\n${body}`, refPattern);
  if (refs.length > 0) {
    extraFrontmatter.shortcut_ids = refs;
    meta.shortcut_id = refs[0];
  }

  return {
    source: 'github',
    sourceId: oid,
    title: headline,
    date,
    url: asStr(get(node, 'url')),
    body,
    suggestedType: 'journal',
    suggestedTags: ['github', 'commit'],
    suggestedProject: slugify(repo),
    meta,
    extraFrontmatter
  };
}

/** Build the commit-history GraphQL query (pure — unit-tested). `hasBranch`
 * picks the ref selector: false ⇒ `defaultBranchRef`, true ⇒ `ref($ref)` with
 * `$ref` = `refs/heads/<branch>`. Both share the `... on Commit { history }`
 * body. `changedFilesIfAvailable` (not the deprecated `changedFiles`) carries
 * change size in the same query — no N+1 (D1). */
export function commitsQuery(hasBranch: boolean): string {
  const inner = `target {
        ... on Commit {
          history(author: { id: $authorId }, since: $since, until: $until, first: $first, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid messageHeadline messageBody authoredDate committedDate url
              additions deletions changedFilesIfAvailable
              parents { totalCount }
            }
          }
        }
      }`;
  const refSelector = hasBranch
    ? `ref(qualifiedName: $ref) { ${inner} }`
    : `defaultBranchRef { ${inner} }`;
  const sig = hasBranch
    ? `query CommitHistory($owner: String!, $name: String!, $ref: String!, $authorId: ID!, $since: GitTimestamp, $until: GitTimestamp, $first: Int!, $cursor: String)`
    : `query CommitHistory($owner: String!, $name: String!, $authorId: ID!, $since: GitTimestamp, $until: GitTimestamp, $first: Int!, $cursor: String)`;
  return `${sig} {
  repository(owner: $owner, name: $name) {
    ${refSelector}
  }
  rateLimit { cost remaining resetAt }
}`;
}

/** Resolve a GitHub login to its `User` node id — the `history(author:)` filter
 * takes a `CommitAuthor { id }`, not a login (D-note §2). One cheap call. */
const RESOLVE_USER_QUERY = `query ResolveUser($login: String!) {
  user(login: $login) { id }
  rateLimit { cost remaining resetAt }
}`;

/** Convert a `YYYY-MM-DD` bound to a `GitTimestamp`, or null when absent (§2). */
function gitTimestamp(date: string | undefined, end: boolean): string | null {
  if (!date) return null;
  return end ? `${date}T23:59:59Z` : `${date}T00:00:00Z`;
}

/** Fetch authored commits on one repo's branch over the GraphQL `history`
 * connection (D1). Deterministic: no LLM, no diff — counts + the verbatim
 * message only. */
async function fetchGithubCommits(http: Http, opts: GithubFetchOpts): Promise<RawItem[]> {
  const repo = (opts.repo ?? '').trim();
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('commit import needs a repo (owner/name)');

  const gqlUrl = graphqlUrl(opts.baseUrl);
  const gqlHeaders = bearer(opts.token, { 'Content-Type': 'application/json', 'User-Agent': 'whoami' });

  const throwOnErrors = (parsed: unknown): void => {
    const errors = get(parsed, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      const msg = asStr(get(errors[0], 'message')) ?? JSON.stringify(errors[0]);
      throw new Error(`GitHub GraphQL error: ${msg}`);
    }
  };

  // 1. Resolve the author login → node id (cannot be done inline; see §2).
  const resolved = await postJson(
    http,
    gqlUrl,
    gqlHeaders,
    { query: RESOLVE_USER_QUERY, variables: { login: opts.user } },
    'GitHub'
  );
  throwOnErrors(resolved);
  const authorId = asStr(get(resolved, 'data', 'user', 'id'));
  if (!authorId) throw new Error(`couldn't resolve GitHub user '${opts.user}'`);

  // 2. Paginate history under the cap (same shape as the items loop).
  const cap = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const first = Math.min(cap, 100);
  const branch = (opts.branch ?? '').trim();
  const hasBranch = branch.length > 0;
  const query = commitsQuery(hasBranch);
  const since = gitTimestamp(opts.since, false);
  const until = gitTimestamp(opts.until, true);
  const excludeMerges = opts.excludeMerges !== false; // default true

  const items: RawItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const variables: Record<string, unknown> = { owner, name, authorId, since, until, first, cursor };
    if (hasBranch) variables.ref = `refs/heads/${branch}`;
    const parsed = await postJson(http, gqlUrl, gqlHeaders, { query, variables }, 'GitHub');
    throwOnErrors(parsed);

    const repository = get(parsed, 'data', 'repository');
    if (repository == null) throw new Error(`repository ${repo} not found or no access`);
    const refNode = hasBranch ? get(repository, 'ref') : get(repository, 'defaultBranchRef');
    if (hasBranch && refNode == null) throw new Error(`branch '${branch}' not found in ${repo}`);
    // No default branch (empty repo), no target, or no commits in window: not an error.
    const history = get(refNode, 'target', 'history');
    const nodes = get(history, 'nodes');
    if (!Array.isArray(nodes)) return items;

    for (const node of nodes) {
      // The only acquisition-side filter (D5/§1.6): structural, user-visible.
      const parents = asNum(get(node, 'parents', 'totalCount')) ?? 0;
      if (excludeMerges && parents > 1) continue;
      items.push(mapGithubCommitNode(node, repo, opts.shortcutRefPattern));
      if (items.length >= cap) break;
    }
    if (items.length >= cap) break;
    if (get(history, 'pageInfo', 'hasNextPage') !== true) break;
    const endCursor = asStr(get(history, 'pageInfo', 'endCursor'));
    if (!endCursor) break;
    cursor = endCursor;
  }
  return items;
}

/** One normalized discussion line — a comment, review comment, or review. */
export interface DiscussionEntry {
  author: string;
  date?: string;
  body: string;
}

/** Map the three raw discussion arrays into one normalized, filtered, ordered
 * stream. Pure — fixture-tested (§4). */
export function selectDiscussion(
  raw: { issueComments: unknown[]; reviewComments: unknown[]; reviews: unknown[] },
  scope: 'self' | 'all',
  selfLogin: string
): DiscussionEntry[] {
  const self = selfLogin.toLowerCase();
  const entries = [...raw.issueComments, ...raw.reviewComments, ...raw.reviews]
    .map((o): DiscussionEntry => ({
      author: asStr(get(o, 'user', 'login')) ?? '',
      // PR reviews carry submitted_at, not created_at.
      date: isoDate(get(o, 'created_at') ?? get(o, 'submitted_at')),
      body: asStr(get(o, 'body'))?.trim() ?? ''
    }))
    // Bare approvals / review stubs carry no text — drop them.
    .filter((e) => e.body !== '')
    .filter((e) => scope === 'all' || e.author.toLowerCase() === self);

  // Ascending by date; undated last; stable for ties (Array.sort is stable).
  return entries.sort((a, b) => {
    if (a.date === b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : 1;
  });
}

/** Render the normalized stream into one capped block. '' when no entries.
 * Pure — fixture-tested (§5). */
export function composeDiscussion(
  entries: DiscussionEntry[],
  scope: 'self' | 'all',
  cap: number
): string {
  if (entries.length === 0) return '';
  const composed = entries
    .map((e) => {
      const d = e.date ?? '????-??-??';
      // In 'self' scope the author is redundant — it's you.
      return scope === 'all' ? `[${d} @${e.author}] ${e.body}` : `[${d}] ${e.body}`;
    })
    .join('\n\n');

  if (composed.length <= cap) return composed;
  // Truncate to cap, then back off to the last newline to avoid a mid-line cut.
  let truncated = composed.slice(0, cap);
  const lastNl = truncated.lastIndexOf('\n');
  if (lastNl > 0) truncated = truncated.slice(0, lastNl);
  return `${truncated}\n… [discussion truncated at ${cap} chars]`;
}

/** Fetch + compose the discussion for one item (§3). Impure: makes ≤3 REST
 * calls (GraphQL Phase 2 would fold these in). `repo` (`owner/name`) and
 * `number` come from the GraphQL node. Throws on any HTTP failure — the caller
 * wraps this per item so a discussion fetch never aborts the run. */
async function fetchItemDiscussion(
  http: Http,
  base: string,
  headers: Record<string, string>,
  repo: string,
  number: number,
  isPr: boolean,
  scope: 'self' | 'all',
  cap: number,
  selfLogin: string
): Promise<string> {
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  // Issue comments exist for issues AND PRs; single page each, no pagination.
  const issueComments = asArray(
    await getJson(http, `${base}/repos/${repo}/issues/${number}/comments?per_page=100`, headers, 'GitHub')
  );
  // Issues have no pulls/* endpoints — only PRs get review (comments|summaries).
  let reviewComments: unknown[] = [];
  let reviews: unknown[] = [];
  if (isPr) {
    reviewComments = asArray(
      await getJson(http, `${base}/repos/${repo}/pulls/${number}/comments?per_page=100`, headers, 'GitHub')
    );
    reviews = asArray(
      await getJson(http, `${base}/repos/${repo}/pulls/${number}/reviews?per_page=100`, headers, 'GitHub')
    );
  }

  const entries = selectDiscussion({ issueComments, reviewComments, reviews }, scope, selfLogin);
  return composeDiscussion(entries, scope, cap);
}

/** Fetch authored issues/PRs in a date range over the GraphQL `search`
 * connection, following the cursor while under the cap. */
export async function fetchGithub(http: Http, opts: GithubFetchOpts): Promise<RawItem[]> {
  // Commit mode returns early — the discussion block below is unreachable, so
  // D6 (no commit-comment fetching) holds with no extra guard.
  if (opts.mode === 'commits') return fetchGithubCommits(http, opts);
  const cap = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const first = Math.min(cap, 100);
  const q = githubSearchQuery(opts); // NOT percent-encoded — rides `variables`.
  const gqlUrl = graphqlUrl(opts.baseUrl);
  const gqlHeaders = bearer(opts.token, {
    'Content-Type': 'application/json',
    'User-Agent': 'whoami'
  });

  const fetchDiscussion = opts.fetchDiscussion === true;
  const scope = opts.commentScope ?? DEFAULT_COMMENT_SCOPE;
  const discussionCap = opts.discussionCharCap ?? DEFAULT_DISCUSSION_CHAR_CAP;
  // The discussion fetch is still REST (Phase 1): its own base + headers.
  const restBase = apiBase(opts.baseUrl);
  const restHeaders = bearer(opts.token, { Accept: 'application/vnd.github+json', 'User-Agent': 'whoami' });

  const items: RawItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const body = { query: AUTHORED_ITEMS_QUERY, variables: { q, first, cursor } };
    const parsed = await postJson(http, gqlUrl, gqlHeaders, body, 'GitHub');
    // GraphQL returns HTTP 200 even on failure, carrying a top-level `errors`
    // array — inspect it rather than trusting the status.
    const errors = get(parsed, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      const msg = asStr(get(errors[0], 'message')) ?? JSON.stringify(errors[0]);
      throw new Error(`GitHub GraphQL error: ${msg}`);
    }
    const search = get(parsed, 'data', 'search');
    const nodes = get(search, 'nodes');
    if (!Array.isArray(nodes)) throw new Error('unexpected GitHub response (no search.nodes array)');

    for (const node of nodes) {
      const item = mapGithubGraphqlNode(node, opts.shortcutRefPattern);
      if (fetchDiscussion) {
        const repo = asStr(get(node, 'repository', 'nameWithOwner'));
        const number = asNum(get(node, 'number'));
        const isPr = asStr(get(node, '__typename')) === 'PullRequest';
        // Per-item resilience (§3.4): a discussion fetch must never abort the
        // run. On any failure, keep the description + header and move on.
        if (repo && number !== undefined) {
          try {
            const discussion = await fetchItemDiscussion(
              http, restBase, restHeaders, repo, number, isPr, scope, discussionCap, opts.user
            );
            if (discussion) item.body = `${item.body ?? ''}\n\n--- Discussion ---\n${discussion}`;
          } catch {
            /* attach no discussion; item keeps its description */
          }
        }
      }
      items.push(item);
      if (items.length >= cap) break;
    }
    if (items.length >= cap) break;
    if (get(search, 'pageInfo', 'hasNextPage') !== true) break;
    const endCursor = asStr(get(search, 'pageInfo', 'endCursor'));
    if (!endCursor) break;
    cursor = endCursor;
  }
  return items;
}

/** Cheap credential check (waid's `validate`): GET /user. */
export async function validateGithub(http: Http, token: string, baseUrl?: string): Promise<void> {
  await getJson(
    http,
    `${apiBase(baseUrl)}/user`,
    bearer(token, { Accept: 'application/vnd.github+json', 'User-Agent': 'whoami' }),
    'GitHub'
  );
}
