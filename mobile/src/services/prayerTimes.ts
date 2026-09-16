import { addDays, fetchDayTimings, localDateString } from '@fitbit-air-tracker/core';
import { useStore } from '../store';

/**
 * Daily prayer-times refresh (Aladhan, keyless). Fills any missing local dates
 * for today..+daysAhead so alarms can be pre-armed a week out; cached days
 * are never re-fetched unless settings change (clearTimetable()).
 */
export async function refreshTimetable(daysAhead = 7): Promise<number> {
  const { settings, timings, setTimings, logEvent } = useStore.getState();
  const now = new Date();
  let fetched = 0;
  let firstError: unknown;
  for (let offset = 0; offset <= daysAhead; offset++) {
    const dateLocal = localDateString(addDays(now, offset), settings.tz);
    if (timings[dateLocal]) continue;
    try {
      const day = await fetchDayTimings({
        lat: settings.lat,
        lng: settings.lng,
        method: settings.calcMethod,
        school: settings.madhab,
        dateLocal,
      });
      setTimings(dateLocal, day.timesUtc, day.hijriDate);
      fetched++;
    } catch (err) {
      firstError ??= err;
    }
  }
  if (fetched > 0) logEvent('timetable.fetched', { days: fetched });
  if (fetched === 0 && firstError && Object.keys(useStore.getState().timings).length === 0) throw firstError;
  return fetched;
}

/** Forget cached timings (after location/method changes) and refetch. */
export async function clearAndRefetch(): Promise<number> {
  useStore.setState({ timings: {}, hijriByDate: {} });
  return refreshTimetable();
}
