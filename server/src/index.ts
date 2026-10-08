import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { Db } from './db/index.js';
import { createServerGoogleHealth } from './providers/googleHealth/index.js';
import { TimetableService, timingKeyForPrayer } from './prayer/timetable.js';
import { PushService } from './push/webpush.js';
import { registerRoutes } from './api/routes.js';
import {
  MockSleepProvider,
  WakeScheduler,
  generateNight,
  samplesToSession,
  systemClock,
  type SleepDataProvider,
} from '@fitbit-air-tracker/core';

loadDotEnv(new URL('../.env', import.meta.url).pathname);
const config = loadConfig();

const db = new Db(config.databasePath);
const user = db.seedDemoUser();

// Google Health API (Fitbit Air) is always wired so the web app can sign in;
// it becomes the active sleep provider when PROVIDER=google_health.
const google = createServerGoogleHealth({
  db,
  userId: user.id,
  clientId: config.googleClientId,
  clientSecret: config.googleClientSecret,
});

const provider: SleepDataProvider =
  config.provider === 'mock'
    ? new MockSleepProvider({ clock: systemClock, syncLagMin: config.mockSyncLagMin })
    : google.provider;

/** Pull the last 14 days of Google sleep sessions into sleep_sessions (idempotent by id). */
async function syncGoogleSessions(): Promise<number> {
  if (!(await google.tokenManager.isConnected())) return 0;
  const now = systemClock.now();
  const sessions = await google.provider.getSessions(user.id, {
    startUtc: new Date(now.getTime() - 14 * 86_400_000),
    endUtc: now,
  });
  for (const s of sessions) db.saveSession(s);
  db.logEvent('google.synced', user.id, { sessions: sessions.length });
  return sessions.length;
}

// Mock mode: seed a week of plausible sleep history so the dashboard has data.
if (provider.name === 'mock' && db.listSessions(user.id, 1).length === 0) {
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const start = new Date(Date.now() - daysAgo * 86_400_000);
    start.setUTCHours(20, 30 + Math.floor(Math.random() * 40), 0, 0); // ≈23:00 Cairo
    const hours = 6.5 + Math.random() * 2;
    db.saveSession(samplesToSession(user.id, generateNight(start, hours, daysAgo), 'mock'));
  }
  db.logEvent('mock.history-seeded', user.id, { nights: 7 });
}

const push = new PushService(db, config);
const timetable = new TimetableService(db);

let lastProviderErrorLog = 0;
const scheduler = new WakeScheduler({
  clock: systemClock,
  provider,
  onError: (err) => {
    // Throttled: the window ticks every 30 s; one log line per 10 min is enough.
    if (Date.now() - lastProviderErrorLog > 600_000) {
      lastProviderErrorLog = Date.now();
      db.logEvent('provider.error', user.id, { provider: provider.name, error: String(err) });
    }
  },
  onFire: async (alarm, decision) => {
    db.insertAlarmEvent({
      userId: alarm.policy.userId,
      policyId: alarm.policy.id,
      type: 'fired',
      reason: decision.reason,
      tsUtc: systemClock.now().toISOString(),
      detail: { detail: decision.detail, prayerTimeUtc: alarm.prayerTimeUtc.toISOString() },
    });
    const payload = {
      type: 'prayer-alarm' as const,
      prayer: alarm.policy.prayer,
      reason: decision.reason,
      firedAtUtc: systemClock.now().toISOString(),
      title: `Time to wake for ${alarm.policy.prayer} 🕌`,
      body:
        decision.reason === 'deadline'
          ? 'Hard deadline reached — prayer time is near.'
          : 'You are in light sleep — the easiest moment to wake.',
    };
    await push.sendToUser(alarm.policy.userId, payload);
    push.startEscalation(alarm.policy.userId, payload);
  },
});

/** Fetch timetable and (re)arm alarms for every enabled policy. */
async function replan(): Promise<void> {
  const u = db.getUser(user.id)!;
  const now = systemClock.now();
  for (const policy of db.getPolicies(u.id).filter((p) => p.enabled)) {
    try {
      const prayerTime = await timetable.nextOccurrence(u, timingKeyForPrayer(policy.prayer), now);
      if (!prayerTime) continue;
      const alarm = scheduler.schedule(policy, prayerTime);
      db.insertAlarmEvent({
        userId: u.id,
        policyId: policy.id,
        type: 'scheduled',
        tsUtc: now.toISOString(),
        detail: {
          prayerTimeUtc: alarm.prayerTimeUtc.toISOString(),
          windowStartUtc: alarm.windowStartUtc.toISOString(),
          deadlineUtc: alarm.deadlineUtc.toISOString(),
        },
      });
    } catch (err) {
      // Prayer API unreachable: keep any previously scheduled alarm; retry on next replan.
      db.logEvent('replan.failed', u.id, { prayer: policy.prayer, error: String(err) });
    }
  }
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await registerRoutes(app, {
  db,
  userId: user.id,
  timetable,
  scheduler,
  push,
  providerName: provider.name,
  replan,
  google: { ...google, clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri, webOrigin: config.webOrigin },
  syncGoogleSessions,
});

// Daily replan shortly after local midnight (new prayer day), plus one at boot.
cron.schedule('30 0 * * *', () => void replan(), { timezone: user.tz });
// Morning history sync for the dashboard (Fitbit Air uploads the night after wake-up).
cron.schedule('0 9 * * *', () => void syncGoogleSessions().catch(() => undefined), { timezone: user.tz });
await replan().catch(() => undefined);
void syncGoogleSessions().catch(() => undefined);
scheduler.startTicking(30_000);

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  {
    provider: provider.name,
    pushConfigured: push.enabled,
    googleConfigured: google.configured,
    googleConnected: await google.tokenManager.isConnected(),
  },
  'fitbit-air-tracker server up',
);
