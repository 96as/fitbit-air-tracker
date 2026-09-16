import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_HEALTH_SCOPES, TokenManager, buildAuthUrl, exchangeCode, refreshAccessToken, type TokenSet, type TokenStore } from './oauth.js';

const clock = { now: () => new Date('2026-07-04T10:00:00Z') };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function memoryStore(initial?: TokenSet): TokenStore & { current?: TokenSet } {
  const s = {
    current: initial,
    async load() {
      return s.current;
    },
    async save(t: TokenSet) {
      s.current = t;
    },
    async clear() {
      s.current = undefined;
    },
  };
  return s;
}

describe('buildAuthUrl', () => {
  it('produces a Google auth URL with PKCE, offline access and the health scopes', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'smartwake:/oauth2redirect', codeChallenge: 'ch', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_HEALTH_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).toContain('googlehealth.sleep.readonly');
  });
});

describe('token exchange + refresh', () => {
  it('exchanges a code with PKCE and no client secret (iOS client)', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toBe('ver');
      expect(body.get('client_secret')).toBeNull();
      return jsonResponse({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 's' });
    });
    const t = await exchangeCode({ clientId: 'cid', code: 'c', codeVerifier: 'ver', redirectUri: 'x', fetchImpl: fetchImpl as typeof fetch, clock });
    expect(t).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', expiresAtUtc: '2026-07-04T11:00:00.000Z' });
  });

  it('keeps the old refresh token when the refresh response omits it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a2', expires_in: 3600 }));
    const t = await refreshAccessToken({
      clientId: 'cid',
      tokens: { accessToken: 'a1', refreshToken: 'r1', expiresAtUtc: '2026-07-04T09:00:00Z' },
      fetchImpl: fetchImpl as typeof fetch,
      clock,
    });
    expect(t.refreshToken).toBe('r1');
    expect(t.accessToken).toBe('a2');
  });

  it('TokenManager returns the cached token while valid and refreshes near expiry', async () => {
    const store = memoryStore({ accessToken: 'a1', refreshToken: 'r1', expiresAtUtc: '2026-07-04T10:00:30Z' }); // expires in 30 s
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a2', expires_in: 3600 }));
    const tm = new TokenManager({ store, clientId: 'cid', fetchImpl: fetchImpl as typeof fetch, clock });
    expect(await tm.getAccessToken()).toBe('a2'); // inside the 60 s skew → refreshed
    expect(store.current?.accessToken).toBe('a2');
    expect(await tm.getAccessToken()).toBe('a2'); // now valid for an hour → no second refresh
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await tm.isConnected()).toBe(true);
  });

  it('TokenManager reports not connected without tokens', async () => {
    const tm = new TokenManager({ store: memoryStore(), clientId: 'cid', clock });
    expect(await tm.isConnected()).toBe(false);
    await expect(tm.getAccessToken()).rejects.toThrow(/not connected/);
  });
});
