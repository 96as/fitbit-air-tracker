export interface AppConfig {
  port: number;
  databasePath: string;
  provider: 'mock' | 'google_health';
  mockSyncLagMin: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject: string;
  /** Google Health API (Web/Desktop OAuth client) — see docs/GOOGLE_HEALTH_API.md */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  /** Where the browser is sent after Google sign-in completes. */
  webOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = env.PROVIDER === 'google_health' ? 'google_health' : 'mock';
  return {
    port: Number(env.PORT ?? 3001),
    databasePath: env.DATABASE_PATH ?? 'data/app.db',
    provider,
    mockSyncLagMin: Number(env.MOCK_SYNC_LAG_MIN ?? 15),
    vapidPublicKey: env.VAPID_PUBLIC_KEY || undefined,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || undefined,
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI || `http://localhost:${env.PORT ?? 3001}/api/v1/auth/google/callback`,
    webOrigin: env.WEB_ORIGIN || 'http://localhost:5173',
  };
}
