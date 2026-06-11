/**
 * GitHub adapter — port of waid's `provider/github.rs`, reoriented for a
 * historical record: instead of "open issues assigned to me now", it pulls
 * issues & PRs **authored by a user inside a date range** via the Search API,
 * which is exactly the Phase-1 "reconstruct a period" query.
 *
 * `mapGithubIssue` is pure and fixture-tested. Network happens only through
 * the Http seam; the token is passed in ready (never loaded here).
 */

import type { Http } from '../types';
import { slugify } from '../ids';
import { bearer, getJson } from './http';
import { asStr, get, isoDate, type RawItem } from './types';

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
}

export const DEFAULT_COMMENT_SCOPE: 'self' | 'all' = 'self';
export const DEFAULT_DISCUSSION_CHAR_CAP = 2000;

/** REST API base: api.github.com, or `{base}/api/v3` for Enterprise. */
export function apiBase(baseUrl?: string): string {
  const b = baseUrl?.trim().replace(/\/+$/, '');
  return b ? `${b}/api/v3` : DEFAULT_API;
}

/** Build the Search-API query string (pure — unit-tested). */
export function githubSearchQuery(o: Pick<GithubFetchOpts, 'user' | 'repo' | 'since' | 'until'>): string {
  const parts = [`author:${o.user}`];
  if (o.repo) parts.push(`repo:${o.repo}`);
  if (o.since && o.until) parts.push(`created:${o.since}..${o.until}`);
  else if (o.since) parts.push(`created:>=${o.since}`);
  else if (o.until) parts.push(`created:<=${o.until}`);
  return parts.join(' ');
}

/** `https://api.github.com/repos/{owner}/{repo}…` → `{owner}/{repo}`. */
export function repoFromApiUrl(apiUrl: string): string | undefined {
  const after = apiUrl.split('/repos/')[1];
  if (!after) return undefined;
  const segs = after.split('/').filter(Boolean);
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : undefined;
}

/** Map one Search-API issue/PR into a RawItem. Pure — fixture-tested. */
export function mapGithubIssue(v: unknown): RawItem {
  const isPr = get(v, 'pull_request') !== undefined;
  const merged = asStr(get(v, 'pull_request', 'merged_at')) != null;
  const repo = asStr(get(v, 'repository_url'))
    ? repoFromApiUrl(asStr(get(v, 'repository_url'))!)
    : undefined;
  const state = asStr(get(v, 'state')) ?? '';
  const created = isoDate(get(v, 'created_at'));
  const closed = isoDate(get(v, 'closed_at'));

  const meta: Record<string, string> = { type: isPr ? 'PR' : 'Issue' };
  if (repo) meta.repo = repo;
  if (state) meta.state = merged ? 'merged' : state;

  const bodyLines = [
    `GitHub ${meta.type}${repo ? ` in ${repo}` : ''}.`,
    `State: ${meta.state || 'unknown'}.`,
    created ? `Opened: ${created}.` : '',
    closed ? `Closed: ${closed}.` : ''
  ].filter(Boolean);

  // Change A: append the description that's already in the Search payload,
  // verbatim. Never capped (that's discussion-only). Absent ⇒ body unchanged.
  let body = bodyLines.join('\n');
  const desc = asStr(get(v, 'body'))?.trim();
  if (desc) body += `\n\n--- Description ---\n${desc}`;

  const idNum = get(v, 'id');

  return {
    source: 'github',
    sourceId: idNum !== undefined && idNum !== null ? String(idNum) : '',
    title: asStr(get(v, 'title')) ?? '',
    // The event date: when work concluded if it did, else when it started.
    date: closed ?? created ?? '',
    url: asStr(get(v, 'html_url')),
    body,
    suggestedType: 'journal',
    suggestedTags: ['github'],
    suggestedProject: repo ? slugify(repo) : undefined,
    meta
  };
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

/** Fetch + compose the discussion for one raw Search item (§3). Impure: makes
 * ≤3 REST calls. Returns '' when there's nothing to add or the item lacks the
 * keys to address its endpoints. Throws on any HTTP failure — the caller wraps
 * this per item so a discussion fetch never aborts the run. */
async function fetchItemDiscussion(
  http: Http,
  base: string,
  headers: Record<string, string>,
  it: unknown,
  scope: 'self' | 'all',
  cap: number,
  selfLogin: string
): Promise<string> {
  const number = get(it, 'number');
  const repoUrl = asStr(get(it, 'repository_url'));
  const repo = repoUrl ? repoFromApiUrl(repoUrl) : undefined;
  if (number === undefined || number === null || !repo) return '';
  const isPr = get(it, 'pull_request') !== undefined;

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

/** Fetch authored issues/PRs in a date range. Paginates the Search API. */
export async function fetchGithub(http: Http, opts: GithubFetchOpts): Promise<RawItem[]> {
  const base = apiBase(opts.baseUrl);
  const cap = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const perPage = Math.min(cap, 100);
  const q = encodeURIComponent(githubSearchQuery(opts));
  const headers = bearer(opts.token, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'whoami'
  });

  const fetchDiscussion = opts.fetchDiscussion === true;
  const scope = opts.commentScope ?? DEFAULT_COMMENT_SCOPE;
  const discussionCap = opts.discussionCharCap ?? DEFAULT_DISCUSSION_CHAR_CAP;

  const items: RawItem[] = [];
  for (let page = 1; items.length < cap; page++) {
    const url = `${base}/search/issues?q=${q}&sort=created&order=asc&per_page=${perPage}&page=${page}`;
    const json = await getJson(http, url, headers, 'GitHub');
    const arr = get(json, 'items');
    if (!Array.isArray(arr)) throw new Error('unexpected GitHub response (no items array)');
    for (const it of arr) {
      const item = mapGithubIssue(it);
      if (fetchDiscussion) {
        // Per-item resilience (§3.4): a discussion fetch must never abort the
        // run. On any failure, keep the description + header and move on.
        try {
          const discussion = await fetchItemDiscussion(http, base, headers, it, scope, discussionCap, opts.user);
          if (discussion) item.body = `${item.body ?? ''}\n\n--- Discussion ---\n${discussion}`;
        } catch {
          /* attach no discussion; item keeps its description */
        }
      }
      items.push(item);
      if (items.length >= cap) break;
    }
    if (arr.length < perPage) break;
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
