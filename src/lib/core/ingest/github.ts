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
}

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

  const idNum = get(v, 'id');

  return {
    source: 'github',
    sourceId: idNum !== undefined && idNum !== null ? String(idNum) : '',
    title: asStr(get(v, 'title')) ?? '',
    // The event date: when work concluded if it did, else when it started.
    date: closed ?? created ?? '',
    url: asStr(get(v, 'html_url')),
    body: bodyLines.join('\n'),
    suggestedType: 'journal',
    suggestedTags: ['github'],
    suggestedProject: repo ? slugify(repo) : undefined,
    meta
  };
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

  const items: RawItem[] = [];
  for (let page = 1; items.length < cap; page++) {
    const url = `${base}/search/issues?q=${q}&sort=created&order=asc&per_page=${perPage}&page=${page}`;
    const json = await getJson(http, url, headers, 'GitHub');
    const arr = get(json, 'items');
    if (!Array.isArray(arr)) throw new Error('unexpected GitHub response (no items array)');
    for (const it of arr) {
      items.push(mapGithubIssue(it));
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
