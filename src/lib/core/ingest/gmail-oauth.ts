/**
 * Gmail OAuth grant — storage model + token refresh (the TS half of the flow).
 *
 * The interactive consent (loopback listener + system browser, PKCE) is the one
 * piece that must live in the native shell (`src-tauri/src/gmail_oauth.rs`,
 * reached through the optional `Platform.oauth` seam). Everything testable —
 * grant parsing, freshness, and the refresh-token exchange — lives here over
 * the plain {@link Http} + {@link Secrets} seams, so it runs under vitest with
 * no Tauri. Keep the grant JSON shape in sync with the Rust module.
 *
 * Bring-your-own client: the user saves their own Google *Desktop* OAuth
 * client id + secret (Who Am I ships no shared Google credentials). Like every
 * secret, all of it lives only in the OS keyring — never the record repo.
 */

import type { Http, Secrets } from '../types';

/** Keyring keys — must match `src-tauri/src/gmail_oauth.rs`. */
export const GMAIL_CLIENT_ID_NAME = 'gmail.client_id';
export const GMAIL_CLIENT_SECRET_NAME = 'gmail.client_secret';
/** The stored grant (JSON, {@link GmailGrant}). */
export const GMAIL_GRANT_NAME = 'gmail.oauth';
/** The pre-OAuth pasted-access-token key. Delete-only: cleared on connect
 * (Rust side) and disconnect so stale entries don't linger in the keyring. */
export const GMAIL_LEGACY_TOKEN_NAME = 'gmail.access_token';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** One Gmail OAuth grant, stored as JSON under {@link GMAIL_GRANT_NAME}. */
export interface GmailGrant {
  /** The connected account, discovered at consent — drives "Connected as …". */
  email: string;
  refresh_token: string;
  access_token: string;
  /** RFC3339; when `access_token` stops being valid. */
  expires_at: string;
}

/** Parse a stored grant, throwing a labelled error on any malformed shape. */
export function parseGmailGrant(raw: string): GmailGrant {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`corrupt Gmail grant: ${String(e)}`);
  }
  const g = v as Record<string, unknown>;
  if (
    !g ||
    typeof g !== 'object' ||
    typeof g.email !== 'string' ||
    typeof g.refresh_token !== 'string' ||
    typeof g.access_token !== 'string' ||
    typeof g.expires_at !== 'string'
  ) {
    throw new Error('corrupt Gmail grant: missing fields');
  }
  return g as unknown as GmailGrant;
}

/** Pure freshness check (with a 60s safety margin). An unparseable timestamp is
 * treated as stale so a corrupt grant forces a refresh, not a crash. */
export function grantIsFresh(expiresAt: string, now: Date): boolean {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t > now.getTime() + 60_000;
}

/** Compute the stored `expires_at` from an `expires_in` (seconds), trimming a
 * small skew so we refresh slightly early. Mirrors the Rust side. */
export function gmailExpiresAt(now: Date, expiresInSecs: number): string {
  const skew = 30;
  const at = new Date(now.getTime() + Math.max(expiresInSecs - skew, 0) * 1000);
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Read the stored grant, or null when Gmail has never been connected. */
export async function readGmailGrant(secrets: Secrets): Promise<GmailGrant | null> {
  const raw = await secrets.get(GMAIL_GRANT_NAME);
  if (!raw) return null;
  return parseGmailGrant(raw);
}

/** Drop the grant (and the legacy pasted token). Keeps the OAuth client id +
 * secret — reconnecting shouldn't mean re-doing the Google Cloud setup. */
export async function disconnectGmail(secrets: Secrets): Promise<void> {
  await secrets.delete(GMAIL_GRANT_NAME);
  await secrets.delete(GMAIL_LEGACY_TOKEN_NAME);
}

/**
 * Return a usable Gmail access token, refreshing (and persisting the refreshed
 * grant) when the cached one is stale — the TS port of waid's
 * `gmail_access_token`. Network + keyring only; never touches the record.
 */
export async function gmailAccessToken(http: Http, secrets: Secrets): Promise<string> {
  const grant = await readGmailGrant(secrets);
  if (!grant) throw new Error('Gmail not connected — click Connect Gmail on the Import page.');
  if (grantIsFresh(grant.expires_at, new Date())) return grant.access_token;

  const clientId = (await secrets.get(GMAIL_CLIENT_ID_NAME))?.trim();
  const clientSecret = (await secrets.get(GMAIL_CLIENT_SECRET_NAME))?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Add your Google OAuth client (ID + secret) on the Import page first.');
  }

  const resp = await http.request({
    url: TOKEN_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: grant.refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });

  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(resp.text) as Record<string, unknown>;
  } catch {
    // A non-JSON body only matters below when the status was OK.
  }
  if (!resp.ok) {
    // A revoked/expired grant comes back as 400 invalid_grant — tell the user
    // to reconnect rather than leaving a cryptic HTTP error.
    if (json.error === 'invalid_grant') {
      throw new Error('Gmail access was revoked or expired — reconnect Gmail on the Import page.');
    }
    throw new Error(`Gmail token refresh failed (${resp.status}): ${String(json.error ?? resp.text.slice(0, 200))}`);
  }
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error('Gmail token response missing access_token');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  // Google usually omits a fresh refresh_token on refresh — keep the existing one.
  const refreshToken =
    typeof json.refresh_token === 'string' && json.refresh_token
      ? json.refresh_token
      : grant.refresh_token;

  const updated: GmailGrant = {
    email: grant.email,
    refresh_token: refreshToken,
    access_token: accessToken,
    expires_at: gmailExpiresAt(new Date(), expiresIn)
  };
  await secrets.set(GMAIL_GRANT_NAME, JSON.stringify(updated));
  return accessToken;
}
