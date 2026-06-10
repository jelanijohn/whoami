/**
 * Gmail adapter — port of waid's `provider/gmail.rs`.
 *
 * Pure / network-only like its siblings: it receives a **ready bearer access
 * token** (the OAuth desktop-loopback+PKCE flow lives at the platform layer,
 * exactly as waid keeps it in `commands.rs`, not the provider module).
 *
 * **Metadata-only**: messages are fetched with `format=metadata` plus the
 * snippet — never bodies. Subjects + snippets are all that ever leave Gmail.
 * Read-only scope (`gmail.readonly`). The `query` is a required Gmail search
 * string (`from:acme.com after:2019/01/01 before:2020/01/01`) — for the
 * Bloomberg-gap use case, date-bounded `in:sent` queries are the workhorse.
 */

import type { Http } from '../types';
import { bearer, getJson } from './http';
import { asStr, get, type RawItem } from './types';

const BASE = 'https://gmail.googleapis.com/gmail/v1';

export interface GmailFetchOpts {
  /** A ready OAuth bearer access token. */
  token: string;
  /** Required Gmail search string — it IS the selection. */
  query: string;
  /** Max messages. Default 25, clamped 1..100. */
  limit?: number;
}

/** Gmail's `internalDate` (string of epoch ms) → ISO 8601, or undefined. */
export function internalDateToIso(ms: unknown): string | undefined {
  const s = asStr(ms)?.trim();
  if (!s || !/^\d+$/.test(s)) return undefined;
  const millis = Number(s);
  if (!Number.isFinite(millis)) return undefined;
  return new Date(millis).toISOString();
}

/** Case-insensitive header lookup in `payload.headers: [{name, value}]`. */
export function header(msg: unknown, name: string): string | undefined {
  const headers = get(msg, 'payload', 'headers');
  if (!Array.isArray(headers)) return undefined;
  const hit = headers.find(
    (h) => asStr(get(h, 'name'))?.toLowerCase() === name.toLowerCase()
  );
  return hit ? asStr(get(hit, 'value')) : undefined;
}

/** Map one Gmail message (metadata form) into a RawItem. Pure —
 * fixture-tested. Never fabricates fields that aren't present. */
export function mapGmailMessage(v: unknown): RawItem {
  const id = asStr(get(v, 'id')) ?? '';
  const from = header(v, 'From');
  const iso = internalDateToIso(get(v, 'internalDate'));
  const snippet = asStr(get(v, 'snippet'))?.trim().slice(0, 200);

  const meta: Record<string, string> = {};
  if (from) meta.from = from;

  const bodyLines = [from ? `From: ${from}` : '', snippet ? `\n${snippet}` : ''].filter(Boolean);

  return {
    source: 'gmail',
    sourceId: id,
    title: header(v, 'Subject')?.trim() || '(no subject)',
    date: iso ? iso.slice(0, 10) : '',
    url: id ? `https://mail.google.com/mail/u/0/#all/${id}` : undefined,
    body: bodyLines.join('\n'),
    suggestedType: 'journal',
    suggestedTags: ['email'],
    meta
  };
}

/** List matching message ids, then fetch each one's metadata (sequential —
 * the cap is modest) and map it. */
export async function fetchGmail(http: Http, opts: GmailFetchOpts): Promise<RawItem[]> {
  const q = opts.query.trim();
  if (!q) {
    throw new Error('Gmail needs a search query (e.g. `in:sent after:2019/01/01 before:2020/01/01`).');
  }
  const max = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const h = bearer(opts.token);

  const list = await getJson(
    http,
    `${BASE}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
    h,
    'Gmail'
  );
  const msgs = get(list, 'messages');
  const ids = Array.isArray(msgs)
    ? msgs.map((m) => asStr(get(m, 'id'))).filter((s): s is string => !!s)
    : [];

  const items: RawItem[] = [];
  for (const id of ids) {
    const msg = await getJson(
      http,
      // metadata only — no bodies leave Gmail (module docs).
      `${BASE}/users/me/messages/${id}?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      h,
      'Gmail'
    );
    items.push(mapGmailMessage(msg));
  }
  return items;
}

/** Cheap credential check: the profile endpoint (works with gmail.readonly). */
export async function validateGmail(http: Http, token: string): Promise<void> {
  await getJson(http, `${BASE}/users/me/profile`, bearer(token), 'Gmail');
}
