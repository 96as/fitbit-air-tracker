import type { Clock } from '../../types.js';

/**
 * Google OAuth 2.0 for the Google Health API — pure, platform-neutral.
 * PKCE verifier/challenge generation is the platform's job (expo-auth-session
 * on the phone, node:crypto on the server); this module only builds URLs and
 * talks to the token endpoint.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/googlehealth.';

/** Read-only scopes this app needs: sleep sessions/stages + heart rate. */
export const GOOGLE_HEALTH_SCOPES = [
  `${SCOPE_PREFIX}sleep.readonly`,
  `${SCOPE_PREFIX}activity_and_fitness.readonly`, // heart-rate lives here
];

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO-8601 UTC instant when accessToken expires. */
  expiresAtUtc: string;
  scope?: string;
  tokenType?: string;
}

/** Where tokens live: SecureStore on the phone, oauth_tokens table on the server. */
export interface TokenStore {
  load(): Promise<TokenSet | undefined>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string; // base64url(SHA-256(verifier))
  state: string;
  scopes?: string[];
  /** Ask for a refresh token (offline) and force the consent screen so one is issued. */
  offline?: boolean;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (p.scopes ?? GOOGLE_HEALTH_SCOPES).join(' '));
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', p.state);
  if (p.offline !== false) {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

interface TokenEndpointResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  clock: Clock,
  previous?: TokenSet,
): Promise<TokenSet> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!res.ok || !json.access_token) {
    throw new GoogleAuthError(json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`, json.error);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previous?.refreshToken,
    expiresAtUtc: new Date(clock.now().getTime() + (json.expires_in ?? 3600) * 1000).toISOString(),
    scope: json.scope ?? previous?.scope,
    tokenType: json.token_type ?? previous?.tokenType,
  };
}

export interface ExchangeCodeParams {
  clientId: string;
  /** Web/Desktop clients only; iOS clients have no secret (PKCE is enough). */
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

export async function exchangeCode(p: ExchangeCodeParams): Promise<TokenSet> {
  const body: Record<string, string> = {
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: p.redirectUri,
  };
  if (p.clientSecret) body.client_secret = p.clientSecret;
  return postToken(body, p.fetchImpl ?? fetch, p.clock ?? { now: () => new Date() });
}

export interface RefreshParams {
  clientId: string;
  clientSecret?: string;
  tokens: TokenSet;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

export async function refreshAccessToken(p: RefreshParams): Promise<TokenSet> {
  if (!p.tokens.refreshToken) throw new GoogleAuthError('no refresh token — user must sign in again', 'no_refresh_token');
  const body: Record<string, string> = {
    client_id: p.clientId,
    refresh_token: p.tokens.refreshToken,
    grant_type: 'refresh_token',
  };
  if (p.clientSecret) body.client_secret = p.clientSecret;
  return postToken(body, p.fetchImpl ?? fetch, p.clock ?? { now: () => new Date() }, p.tokens);
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
}

/**
 * Hands out a valid access token, refreshing it ~60 s before expiry and
 * persisting the result. Plug its getAccessToken into GoogleHealthClient.
 */
export class TokenManager {
  private inflight?: Promise<string>;

  constructor(
    private readonly opts: {
      store: TokenStore;
      clientId: string;
      clientSecret?: string;
      fetchImpl?: typeof fetch;
      clock?: Clock;
      /** Refresh this many ms before expiry. */
      skewMs?: number;
    },
  ) {}

  async isConnected(): Promise<boolean> {
    const t = await this.opts.store.load();
    return Boolean(t?.refreshToken || (t && new Date(t.expiresAtUtc) > (this.opts.clock ?? { now: () => new Date() }).now()));
  }

  getAccessToken = async (): Promise<string> => {
    if (!this.inflight) {
      this.inflight = this.resolve().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  };

  private async resolve(): Promise<string> {
    const clock = this.opts.clock ?? { now: () => new Date() };
    const tokens = await this.opts.store.load();
    if (!tokens) throw new GoogleAuthError('not connected to Google', 'not_connected');
    const skew = this.opts.skewMs ?? 60_000;
    if (new Date(tokens.expiresAtUtc).getTime() - skew > clock.now().getTime()) return tokens.accessToken;
    const fresh = await refreshAccessToken({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      tokens,
      fetchImpl: this.opts.fetchImpl,
      clock,
    });
    await this.opts.store.save(fresh);
    return fresh.accessToken;
  }

  /** Force a refresh (e.g. after an API 401) and return the new token. */
  async forceRefresh(): Promise<string> {
    const tokens = await this.opts.store.load();
    if (!tokens) throw new GoogleAuthError('not connected to Google', 'not_connected');
    const fresh = await refreshAccessToken({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      tokens,
      fetchImpl: this.opts.fetchImpl,
      clock: this.opts.clock,
    });
    await this.opts.store.save(fresh);
    return fresh.accessToken;
  }
}
