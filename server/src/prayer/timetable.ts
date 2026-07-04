import type { Db } from '../db/index.js';
import type { User } from '../types.js';
import { fetchDayTimings, localDateString, type DayTimings } from './aladhan.js';

/**
 * Cached prayer timetable: one Aladhan fetch per (user, local date, method),
 * stored in prayer_timetable. Everything downstream (wake engine, dashboard)
 * reads through here.
 */
export class TimetableService {
  constructor(
    private readonly db: Db,
    private readonly fetcher: typeof fetchDayTimings = fetchDayTimings,
  ) {}

  /** Timings for a local date, fetching + caching on miss. */
  async getForDate(user: User, dateLocal: string): Promise<Record<string, string>> {
    const cached = this.db.getTimetable(user.id, dateLocal);
    if (cached.length > 0) {
      return Object.fromEntries(cached.map((e) => [e.prayer, e.timeUtc]));
    }
    const day: DayTimings = await this.fetcher({
      lat: user.lat,
      lng: user.lng,
      method: user.calcMethod,
      school: user.madhab,
      dateLocal,
    });
    this.db.saveTimetable(
      user.id,
      dateLocal,
      user.calcMethod,
      Object.entries(day.timesUtc).map(([prayer, timeUtc]) => ({ prayer, timeUtc })),
      JSON.stringify({ hijri: day.hijriDate, timezone: day.timezone }),
    );
    this.db.logEvent('timetable.fetched', user.id, { dateLocal, hijri: day.hijriDate });
    return day.timesUtc;
  }

  /** Timings for the user's current local date. */
  async getForToday(user: User, now: Date = new Date()): Promise<Record<string, string>> {
    return this.getForDate(user, localDateString(now, user.tz));
  }

  /**
   * Next occurrence of a timing key at or after `now` (checks today then
   * tomorrow — e.g. Fajr has usually passed by evening).
   */
  async nextOccurrence(user: User, timingKey: string, now: Date): Promise<Date | undefined> {
    for (const dayOffset of [0, 1]) {
      const date = new Date(now.getTime() + dayOffset * 86_400_000);
      const times = await this.getForDate(user, localDateString(date, user.tz));
      const iso = times[timingKey];
      if (iso && new Date(iso) >= now) return new Date(iso);
    }
    return undefined;
  }
}

/** Map an alarm policy's prayer to the Aladhan timing key that anchors it. */
export function timingKeyForPrayer(prayer: string): string {
  switch (prayer) {
    case 'qiyam':
      return 'lastthird';
    case 'suhoor':
      return 'fajr'; // suhoor deadline is Fajr; the policy's offset carves out eating time
    default:
      return prayer;
  }
}
