import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest, HttpResponse, Secrets } from '../types';
import {
  GMAIL_CLIENT_ID_NAME,
  GMAIL_CLIENT_SECRET_NAME,
  GMAIL_GRANT_NAME,
  GMAIL_LEGACY_TOKEN_NAME,
  disconnectGmail,
  gmailAccessToken,
  gmailExpiresAt,
  grantIsFresh,
  parseGmailGrant,
  readGmailGrant,
  type GmailGrant
} from './gmail-oauth';

/** In-memory Secrets seam. */
function memSecrets(initial: Record<string, string> = {}): Secrets & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

/** Scripted Http seam recording every request. */
function scriptedHttp(responses: HttpResponse[]): Http & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      const next = responses.shift();
      if (!next) throw new Error('unexpected HTTP request in test');
      return next;
    }
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(body)
  };
}

function grant(overrides: Partial<GmailGrant> = {}): GmailGrant {
  return {
    email: 'me@example.com',
    refresh_token: 'refresh-1',
    access_token: 'access-1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides
  };
}

const CLIENT = {
  [GMAIL_CLIENT_ID_NAME]: 'client-id.apps.googleusercontent.com',
  [GMAIL_CLIENT_SECRET_NAME]: 'client-secret'
};

describe('grantIsFresh', () => {
  const now = new Date('2026-07-04T12:00:00Z');

  it('is fresh well before expiry', () => {
    expect(grantIsFresh('2026-07-04T13:00:00Z', now)).toBe(true);
  });

  it('is stale after expiry', () => {
    expect(grantIsFresh('2026-07-04T11:00:00Z', now)).toBe(false);
  });

  it('is stale inside the 60s safety margin', () => {
    expect(grantIsFresh('2026-07-04T12:00:59Z', now)).toBe(false);
    expect(grantIsFresh('2026-07-04T12:01:01Z', now)).toBe(true);
  });

  it('treats an unparseable timestamp as stale (forces a refresh, no crash)', () => {
    expect(grantIsFresh('not-a-date', now)).toBe(false);
  });
});

describe('gmailExpiresAt', () => {
  const now = new Date('2026-07-04T12:00:00Z');

  it('trims a 30s skew off expires_in', () => {
    expect(gmailExpiresAt(now, 3600)).toBe('2026-07-04T12:59:30Z');
  });

  it('clamps a tiny expires_in to now instead of going negative', () => {
    expect(gmailExpiresAt(now, 10)).toBe('2026-07-04T12:00:00Z');
  });
});

describe('parseGmailGrant', () => {
  it('round-trips a valid grant', () => {
    const g = grant();
    expect(parseGmailGrant(JSON.stringify(g))).toEqual(g);
  });

  it('throws a labelled error on invalid JSON', () => {
    expect(() => parseGmailGrant('{nope')).toThrow(/corrupt Gmail grant/);
  });

  it('throws a labelled error on missing fields', () => {
    expect(() => parseGmailGrant(JSON.stringify({ email: 'x' }))).toThrow(
      /corrupt Gmail grant: missing fields/
    );
  });
});

describe('readGmailGrant / disconnectGmail', () => {
  it('returns null when never connected', async () => {
    expect(await readGmailGrant(memSecrets())).toBeNull();
  });

  it('disconnect removes the grant and the legacy pasted token, keeps the client', async () => {
    const secrets = memSecrets({
      ...CLIENT,
      [GMAIL_GRANT_NAME]: JSON.stringify(grant()),
      [GMAIL_LEGACY_TOKEN_NAME]: 'ya29.old'
    });
    await disconnectGmail(secrets);
    expect(secrets.store.has(GMAIL_GRANT_NAME)).toBe(false);
    expect(secrets.store.has(GMAIL_LEGACY_TOKEN_NAME)).toBe(false);
    expect(secrets.store.get(GMAIL_CLIENT_ID_NAME)).toBe(CLIENT[GMAIL_CLIENT_ID_NAME]);
  });
});

describe('gmailAccessToken', () => {
  it('returns the cached token without any HTTP when fresh', async () => {
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(grant()) });
    const http = scriptedHttp([]);
    expect(await gmailAccessToken(http, secrets)).toBe('access-1');
    expect(http.requests).toHaveLength(0);
  });

  it('throws a connect hint when no grant is stored', async () => {
    await expect(gmailAccessToken(scriptedHttp([]), memSecrets(CLIENT))).rejects.toThrow(
      /Gmail not connected/
    );
  });

  it('throws a setup hint when the OAuth client is missing', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    await expect(gmailAccessToken(scriptedHttp([]), secrets)).rejects.toThrow(
      /Add your Google OAuth client/
    );
  });

  it('refreshes a stale grant with a form-encoded POST and persists the result', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    const http = scriptedHttp([jsonResponse(200, { access_token: 'access-2', expires_in: 3600 })]);

    expect(await gmailAccessToken(http, secrets)).toBe('access-2');

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.url).toBe('https://oauth2.googleapis.com/token');
    expect(req.method).toBe('POST');
    expect(req.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(req.body ?? '');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe(CLIENT[GMAIL_CLIENT_ID_NAME]);
    expect(body.get('client_secret')).toBe(CLIENT[GMAIL_CLIENT_SECRET_NAME]);

    const updated = parseGmailGrant(secrets.store.get(GMAIL_GRANT_NAME)!);
    expect(updated.access_token).toBe('access-2');
    // Google omits refresh_token on refresh — the old one and the email survive.
    expect(updated.refresh_token).toBe('refresh-1');
    expect(updated.email).toBe('me@example.com');
    expect(grantIsFresh(updated.expires_at, new Date())).toBe(true);
  });

  it('adopts a rotated refresh_token when the response carries one', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    const http = scriptedHttp([
      jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    ]);
    await gmailAccessToken(http, secrets);
    expect(parseGmailGrant(secrets.store.get(GMAIL_GRANT_NAME)!).refresh_token).toBe('refresh-2');
  });

  it('maps invalid_grant to a reconnect message', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    const http = scriptedHttp([jsonResponse(400, { error: 'invalid_grant' })]);
    await expect(gmailAccessToken(http, secrets)).rejects.toThrow(/revoked or expired — reconnect/);
  });

  it('surfaces other refresh failures with status + error', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    const http = scriptedHttp([jsonResponse(500, { error: 'backend_error' })]);
    await expect(gmailAccessToken(http, secrets)).rejects.toThrow(
      /Gmail token refresh failed \(500\): backend_error/
    );
  });

  it('rejects a success response with no access_token', async () => {
    const stale = grant({ expires_at: '2020-01-01T00:00:00Z' });
    const secrets = memSecrets({ ...CLIENT, [GMAIL_GRANT_NAME]: JSON.stringify(stale) });
    const http = scriptedHttp([jsonResponse(200, { expires_in: 3600 })]);
    await expect(gmailAccessToken(http, secrets)).rejects.toThrow(/missing access_token/);
  });
});
