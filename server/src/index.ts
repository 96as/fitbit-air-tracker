import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { Db } from './db/index.js';
import { MockSleepProvider, generateNight, samplesToSession } from './providers/mock/index.js';
import { GoogleHealthProvider } from './providers/googleHealth/index.js';
import type { SleepDataProvider } from './providers/types.js';
import { TimetableService, timingKeyForPrayer } from './prayer/timetable.js';
import { WakeScheduler } from './wake/scheduler.js';
import { PushService } from './push/webpush.js';
import { registerRoutes } from './api/routes.js';
import { systemClock } from './types.js';

loadDotEnv(new URL('../.env', import.meta.url).pathname);
const config = loadConfig();

const db = new Db(config.databasePath);
const user = db.seedDemoUser();

const provider: SleepDataProvider =
  config.provider === 'mock'
    ? new MockSleepProvider({ clock: systemClock, syncLagMin: config.mockSyncLagMin })
    : new GoogleHealthProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      });

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

const scheduler = new WakeScheduler({
  clock: systemClock,
  provider,
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
});

// Daily replan shortly after local midnight (new prayer day), plus one at boot.
cron.schedule('30 0 * * *', () => void replan(), { timezone: user.tz });
await replan().catch(() => undefined);
scheduler.startTicking(30_000);

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  { provider: provider.name, pushConfigured: push.enabled },
  'fitbit-air-tracker server up',
);
