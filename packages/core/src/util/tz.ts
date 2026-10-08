/** Timezone helpers built only on Intl (works in Node, browsers, Hermes). */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD wall date for an instant in an IANA timezone (DST-safe). */
export function localDateString(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD local date. */
export function weekdayOfLocalDate(dateLocal: string): number {
  const [y, m, d] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** Offset (minutes east of UTC) that `tz` has at `instant`. */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * UTC instant for a wall-clock time (HH:MM) on a local date in `tz`.
 * Two-pass offset correction handles DST transitions.
 */
export function wallTimeToUtc(dateLocal: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateLocal.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  let guess = new Date(naive - tzOffsetMinutes(new Date(naive), tz) * 60_000);
  guess = new Date(naive - tzOffsetMinutes(guess, tz) * 60_000);
  return guess;
}
