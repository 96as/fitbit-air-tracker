import { addDays, localDateString } from '../util/tz.js';

/** Timings keyed by local date (YYYY-MM-DD) → timing key → ISO-8601 UTC. */
export type TimingsByDate = Record<string, Record<string, string>>;

/** Map an alarm's prayer to the Aladhan timing key that anchors it. */
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

/**
 * Next occurrence of a timing key at or after `now`, looking ahead
 * `daysAhead` local days (Fajr has usually passed by evening → tomorrow).
 */
export function nextOccurrence(
  timings: TimingsByDate,
  timingKey: string,
  now: Date,
  tz: string,
  daysAhead = 1,
): Date | undefined {
  for (let offset = 0; offset <= daysAhead; offset++) {
    const iso = timings[localDateString(addDays(now, offset), tz)]?.[timingKey];
    if (iso && new Date(iso) >= now) return new Date(iso);
  }
  return undefined;
}
