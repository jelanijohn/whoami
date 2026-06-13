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
