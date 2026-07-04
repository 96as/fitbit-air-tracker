export interface AppConfig {
  port: number;
  databasePath: string;
  provider: 'mock' | 'google_health';
  mockSyncLagMin: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject: string;
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
  };
}
