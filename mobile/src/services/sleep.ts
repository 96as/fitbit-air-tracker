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

/**
 * Sleep data on the phone. Today: the core mock simulator (honest ~15 min
 * sync lag). Later: a Google Health API provider using on-device OAuth
 * (see docs/ROADMAP.md) behind the same SleepDataProvider interface.
 */
export function makeSleepProvider(clock: Clock = systemClock, sleepStartUtc: Date = clock.now(), seed?: number): SleepDataProvider {
  return new MockSleepProvider({ clock, syncLagMin: 15, sleepStartUtc, nightHours: 9, seed });
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
