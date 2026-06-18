/**
 * Shared HTTP helpers for adapters — the TypeScript port of waid's
 * `provider/mod.rs` `read_json`: JSON GET with provider-labelled errors and a
 * clear credentials message on 401/403.
 */

import type { Http } from '../types';

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
    throw new Error(`${provider} returned ${resp.status}: ${resp.text.slice(0, 200)}`);
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
    throw new Error(`${provider} returned ${resp.status}: ${resp.text.slice(0, 200)}`);
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
