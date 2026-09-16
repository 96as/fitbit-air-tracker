/**
 * Aladhan prayer-times client (free, keyless): https://aladhan.com/prayer-times-api
 * We request iso8601=true so every timing arrives with its UTC offset and can
 * be stored as an exact instant — no timezone math on our side.
 */

export interface AladhanRequest {
  lat: number;
  lng: number;
  method: number; // calculation method id (e.g. 5 = Egyptian GAS, 4 = Umm al-Qura, 3 = MWL)
  school: 0 | 1; // Asr: 0 = Shafi, 1 = Hanafi
  dateLocal: string; // YYYY-MM-DD (user's local date)
}

export interface DayTimings {
  dateLocal: string;
  /** timing key (lowercase: fajr, sunrise, dhuhr, asr, maghrib, isha, midnight, lastthird) → ISO-8601 UTC */
  timesUtc: Record<string, string>;
  hijriDate: string;
  timezone: string;
}

const BASE_URL = 'https://api.aladhan.com/v1/timings';

/** Timing keys we persist. `lastthird` powers Qiyam mode; hijri powers Ramadan mode. */
const KEYS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha', 'Midnight', 'Lastthird'];

export async function fetchDayTimings(
  req: AladhanRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DayTimings> {
  const [y, m, d] = req.dateLocal.split('-');
  const url = new URL(`${BASE_URL}/${d}-${m}-${y}`);
  url.searchParams.set('latitude', String(req.lat));
  url.searchParams.set('longitude', String(req.lng));
  url.searchParams.set('method', String(req.method));
  url.searchParams.set('school', String(req.school));
  url.searchParams.set('iso8601', 'true');

  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`Aladhan API error: HTTP ${res.status}`);
  const body = (await res.json()) as {
    code: number;
    data: {
      timings: Record<string, string>;
      date: { hijri: { date: string } };
      meta: { timezone: string };
    };
  };
  if (body.code !== 200) throw new Error(`Aladhan API error: code ${body.code}`);

  const timesUtc: Record<string, string> = {};
  for (const key of KEYS) {
    const iso = body.data.timings[key];
    if (iso) timesUtc[key.toLowerCase()] = new Date(iso).toISOString();
  }
  return {
    dateLocal: req.dateLocal,
    timesUtc,
    hijriDate: body.data.date.hijri.date,
    timezone: body.data.meta.timezone,
  };
}

export { localDateString } from '../util/tz.js';
