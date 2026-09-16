import {
  MockSleepProvider,
  generateNight,
  samplesToSession,
  systemClock,
  wallTimeToUtc,
  localDateString,
  addDays,
  type Clock,
  type SleepDataProvider,
  type SleepSession,
} from '@fitbit-air-tracker/core';
import { useStore } from '../store';
import { makeGoogleProvider } from './googleAuth';

/**
 * Sleep data on the phone, behind the shared SleepDataProvider seam:
 * - 'google' (and connected): real Fitbit Air data via the Google Health API
 * - otherwise: the core mock simulator (honest ~15 min sync lag)
 * `forceMock` is used by the Bedside demo, which must not touch the real API.
 */
export function makeSleepProvider(
  clock: Clock = systemClock,
  sleepStartUtc: Date = clock.now(),
  seed?: number,
  forceMock = false,
): SleepDataProvider {
  const { settings, googleConnected } = useStore.getState();
  if (!forceMock && settings.sleepSource === 'google' && googleConnected) {
    return makeGoogleProvider(settings.googleIosClientId, clock);
  }
  return new MockSleepProvider({ clock, syncLagMin: 15, sleepStartUtc, nightHours: 9, seed });
}

export function usingRealData(): boolean {
  const { settings, googleConnected } = useStore.getState();
  return settings.sleepSource === 'google' && googleConnected;
}

/** Pull the last 14 nights from Google into store.sessions (replaces simulated history). */
export async function syncGoogleHistory(): Promise<number> {
  if (!usingRealData()) return 0;
  const { settings, setSessions, logEvent } = useStore.getState();
  const now = new Date();
  const sessions = await makeGoogleProvider(settings.googleIosClientId).getSessions('me', {
    startUtc: addDays(now, -14),
    endUtc: now,
  });
  if (sessions.length > 0) setSessions(sessions);
  logEvent('google.synced', { sessions: sessions.length });
  return sessions.length;
}

/** Seven plausible past nights (23:00 local bedtime) so the Tonight tab has history. */
export function seedSleepHistory(): SleepSession[] {
  const { settings, setSessions, logEvent } = useStore.getState();
  const now = new Date();
  const sessions: SleepSession[] = [];
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const date = localDateString(addDays(now, -daysAgo), settings.tz);
    const start = wallTimeToUtc(date, `${22 + (daysAgo % 2)}:${daysAgo % 2 ? '45' : '10'}`, settings.tz);
    const samples = generateNight(start, 6.5 + (daysAgo % 3) * 0.6, daysAgo);
    sessions.push(samplesToSession('me', samples, 'mock'));
  }
  setSessions(sessions);
  logEvent('mock.history-seeded', { nights: sessions.length });
  return sessions;
}
