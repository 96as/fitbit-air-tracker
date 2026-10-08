import {
  GoogleHealthClient,
  GoogleHealthProvider,
  TokenManager,
  systemClock,
  type Clock,
  type TokenSet,
  type TokenStore,
} from '@fitbit-air-tracker/core';
import type { Db } from '../../db/index.js';

/**
 * Server-side Google Health provider: the shared core client + token logic,
 * with tokens persisted in the oauth_tokens table. Sign-in happens through the
 * /api/v1/auth/google/* routes (Web-application OAuth client with a secret).
 */

export const GOOGLE_PROVIDER_KEY = 'google_health';

export class DbTokenStore implements TokenStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}
  async load(): Promise<TokenSet | undefined> {
    return this.db.getOAuthToken(this.userId, GOOGLE_PROVIDER_KEY);
  }
  async save(tokens: TokenSet): Promise<void> {
    this.db.saveOAuthToken(this.userId, GOOGLE_PROVIDER_KEY, tokens);
  }
  async clear(): Promise<void> {
    this.db.deleteOAuthToken(this.userId, GOOGLE_PROVIDER_KEY);
  }
}

export interface ServerGoogleHealth {
  provider: GoogleHealthProvider;
  tokenManager: TokenManager;
  store: DbTokenStore;
  configured: boolean;
}

export function createServerGoogleHealth(opts: {
  db: Db;
  userId: string;
  clientId?: string;
  clientSecret?: string;
  clock?: Clock;
}): ServerGoogleHealth {
  const clock = opts.clock ?? systemClock;
  const store = new DbTokenStore(opts.db, opts.userId);
  const tokenManager = new TokenManager({
    store,
    clientId: opts.clientId ?? '',
    clientSecret: opts.clientSecret,
    clock,
  });
  const client = new GoogleHealthClient({
    getAccessToken: tokenManager.getAccessToken,
    onUnauthorized: () => tokenManager.forceRefresh(),
  });
  return {
    provider: new GoogleHealthProvider({ client, clock }),
    tokenManager,
    store,
    configured: Boolean(opts.clientId && opts.clientSecret),
  };
}
