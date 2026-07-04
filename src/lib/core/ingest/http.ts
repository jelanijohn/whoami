/**
 * Shared HTTP helpers for adapters — the TypeScript port of waid's
 * `provider/mod.rs` `read_json`: JSON GET with provider-labelled errors and a
 * clear credentials message on 401/403.
 */

import type { Http, HttpResponse } from '../types';

/**
 * Human-readable failure line for a non-2xx response. Providers serve their
 * 5xx pages as HTML (GitHub's 504 "unicorn" page, say) and 200 chars of
 * markup tells the user nothing, so an HTML body is dropped. A 502/504 is a
 * server-side timeout — for GitHub GraphQL that usually means the query was
 * too expensive (e.g. a commit history over a very wide date range) — so it
 * gets a plain-language hint instead of a body.
 */
export function httpFailureMessage(provider: string, resp: HttpResponse): string {
  if (resp.status === 502 || resp.status === 504) {
    return `${provider} returned ${resp.status} — the server timed out. Try again, or narrow the import (smaller date range or limit).`;
  }
  const contentType = resp.headers['content-type'] ?? resp.headers['Content-Type'] ?? '';
  const looksHtml = /text\/html/i.test(contentType) || /^\s*(<!doctype|<html)/i.test(resp.text);
  if (looksHtml) return `${provider} returned ${resp.status} (HTML error page)`;
  return `${provider} returned ${resp.status}: ${resp.text.slice(0, 200)}`;
}

export async function getJson(
  http: Http,
  url: string,
  headers: Record<string, string>,
  provider: string
): Promise<unknown> {
  const resp = await http.request({ url, method: 'GET', headers });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`${provider} rejected the credentials — check the connection settings.`);
  }
  if (!resp.ok) {
    throw new Error(httpFailureMessage(provider, resp));
  }
  try {
    return JSON.parse(resp.text) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from ${provider}: ${String(e)}`);
  }
}

/**
 * POST variant of {@link getJson} — same provider-labelled error handling, but
 * sends `bodyObj` as a JSON body. Used by the GitHub GraphQL adapter.
 *
 * Caveat: a GraphQL endpoint returns **HTTP 200 even on failure**, carrying a
 * top-level `errors` array. This helper only handles the transport (status +
 * JSON parse); the caller MUST inspect `parsed.errors` itself.
 */
export async function postJson(
  http: Http,
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown,
  provider: string
): Promise<unknown> {
  const resp = await http.request({ url, method: 'POST', headers, body: JSON.stringify(bodyObj) });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`${provider} rejected the credentials — check the connection settings.`);
  }
  if (!resp.ok) {
    throw new Error(httpFailureMessage(provider, resp));
  }
  try {
    return JSON.parse(resp.text) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from ${provider}: ${String(e)}`);
  }
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra };
}

/** The buffered result of a {@link getText} fetch (website-import spec §3.1). */
export interface FetchedText {
  /** The final URL after redirects, when the seam surfaces it; otherwise the
   * requested URL (the {@link HttpResponse} contract buffers but does not expose
   * `fetch`'s post-redirect `url`, so this is best-effort). */
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

/**
 * A text-returning sibling of {@link getJson} for the website importer
 * (website-import spec §3.1): it does NOT JSON-parse — it returns the raw body,
 * its content-type, and the final URL. Same provider-labelled error handling;
 * a non-2xx throws so the per-page caller in `acquire.ts` can record it and
 * carry on (one bad page never aborts the run).
 *
 * Sends a descriptive User-Agent and an HTML Accept header. Redirect-following
 * happens inside the `Http` seam (node/webview `fetch` both follow by default).
 */
export async function getText(http: Http, url: string, provider: string): Promise<FetchedText> {
  const resp = await http.request({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'whoami-import/0.1',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!resp.ok) {
    throw new Error(`${provider} returned ${resp.status}`);
  }
  // Headers may be cased either way depending on the seam impl; check both.
  const contentType = resp.headers['content-type'] ?? resp.headers['Content-Type'] ?? '';
  const finalUrl =
    resp.headers['content-location'] ?? resp.headers['Content-Location'] ?? url;
  return { finalUrl, status: resp.status, contentType, text: resp.text };
}
