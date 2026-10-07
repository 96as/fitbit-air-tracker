import { describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient } from './api.js';
import { ALL_NIGHT_DATA_TYPES, assembleNightData, fetchNightData, filterForType, type NightDataType } from './night.js';
import { mapHeartRate, perMinuteMean } from './mapping.js';
import type { GhDataPoint, GhListDataPointsResponse } from './types.js';
import sleepStages from './__fixtures__/sleep-stages.json';
import sleepClassic from './__fixtures__/sleep-classic.json';
import heartRate from './__fixtures__/night/heart-rate.json';
import hrv from './__fixtures__/night/heart-rate-variability.json';
import dailyHrv from './__fixtures__/night/daily-heart-rate-variability.json';
import restingHr from './__fixtures__/night/daily-resting-heart-rate.json';
import spo2 from './__fixtures__/night/oxygen-saturation.json';
import dailySpo2 from './__fixtures__/night/daily-oxygen-saturation.json';
import respSummary from './__fixtures__/night/respiratory-rate-sleep-summary.json';
import dailyResp from './__fixtures__/night/daily-respiratory-rate.json';
import temp from './__fixtures__/night/daily-sleep-temperature-derivations.json';
import steps from './__fixtures__/night/steps.json';
import sedentary from './__fixtures__/night/sedentary-period.json';

const FIXTURES: Record<NightDataType, GhListDataPointsResponse> = {
  sleep: {
    dataPoints: [...(sleepStages as GhListDataPointsResponse).dataPoints!, ...(sleepClassic as GhListDataPointsResponse).dataPoints!],
  },
  'heart-rate': heartRate as GhListDataPointsResponse,
  'heart-rate-variability': hrv as GhListDataPointsResponse,
  'daily-heart-rate-variability': dailyHrv as GhListDataPointsResponse,
  'daily-resting-heart-rate': restingHr as GhListDataPointsResponse,
  'oxygen-saturation': spo2 as GhListDataPointsResponse,
  'daily-oxygen-saturation': dailySpo2 as GhListDataPointsResponse,
  'respiratory-rate-sleep-summary': respSummary as GhListDataPointsResponse,
  'daily-respiratory-rate': dailyResp as GhListDataPointsResponse,
  'daily-sleep-temperature-derivations': temp as GhListDataPointsResponse,
  steps: steps as GhListDataPointsResponse,
  'sedentary-period': sedentary as GhListDataPointsResponse,
};

const PARAMS = {
  dateLocal: '2026-07-04',
  tz: 'Asia/Riyadh',
  startUtc: '2026-07-03T15:00:00Z', // 18:00 local the evening before
  endUtc: '2026-07-04T11:00:00Z', // 14:00 local
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const typeOf = (url: string) => /dataTypes\/([^/]+)\/dataPoints/.exec(url)![1] as NightDataType;

function fakeClient(override: Partial<Record<NightDataType, (url: URL) => Response>> = {}) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const type = typeOf(url.toString());
    return override[type]?.(url) ?? json(FIXTURES[type]);
  });
  const client = new GoogleHealthClient({ getAccessToken: async () => 't', fetchImpl: fetchImpl as typeof fetch, retryBaseMs: 0 });
  return { client, calls, fetchImpl };
}

describe('filterForType — exact AIP-160 filters per record type', () => {
  const p = { dateLocal: '2026-07-04', startUtc: new Date(PARAMS.startUtc), endUtc: new Date(PARAMS.endUtc) };
  it('sleep → end_time; samples → sample_time.physical_time; intervals → interval.start_time; daily → date', () => {
    expect(filterForType('sleep', p)).toBe('sleep.interval.end_time >= "2026-07-03T15:00:00Z" AND sleep.interval.end_time < "2026-07-04T11:00:00Z"');
    expect(filterForType('heart-rate-variability', p)).toBe(
      'heart_rate_variability.sample_time.physical_time >= "2026-07-03T15:00:00Z" AND heart_rate_variability.sample_time.physical_time < "2026-07-04T11:00:00Z"',
    );
    expect(filterForType('respiratory-rate-sleep-summary', p)).toContain('respiratory_rate_sleep_summary.sample_time.physical_time >= ');
    expect(filterForType('oxygen-saturation', p)).toContain('oxygen_saturation.sample_time.physical_time');
    expect(filterForType('steps', p)).toBe('steps.interval.start_time >= "2026-07-03T15:00:00Z" AND steps.interval.start_time < "2026-07-04T11:00:00Z"');
    expect(filterForType('sedentary-period', p)).toContain('sedentary_period.interval.start_time >= ');
    expect(filterForType('daily-heart-rate-variability', p)).toBe(
      'daily_heart_rate_variability.date >= "2026-07-04" AND daily_heart_rate_variability.date < "2026-07-05"',
    );
    expect(filterForType('daily-sleep-temperature-derivations', { ...p, dateLocal: '2026-12-31' })).toBe(
      'daily_sleep_temperature_derivations.date >= "2026-12-31" AND daily_sleep_temperature_derivations.date < "2027-01-01"',
    );
  });
});

describe('fetchNightData', () => {
  it('fetches every type and maps each into NightData', async () => {
    const { client, calls } = fakeClient();
    const { night, errors, counts, heartRateMotion } = await fetchNightData(client, PARAMS);

    expect(errors).toEqual({});
    expect(new Set(calls.map((u) => typeOf(u.toString())))).toEqual(new Set(ALL_NIGHT_DATA_TYPES));
    expect(calls.find((u) => u.pathname.endsWith('/sleep/dataPoints'))!.searchParams.get('pageSize')).toBe('25');
    expect(calls.find((u) => u.pathname.endsWith('/heart-rate/dataPoints'))!.searchParams.get('pageSize')).toBe('10000');
    expect(counts['heart-rate']).toBe(6);

    expect(night.dateLocal).toBe('2026-07-04');
    expect(night.tz).toBe('Asia/Riyadh');
    // Main sleep chosen over the classic nap; Google-only meta stripped.
    expect(night.session?.id).toBe('users/me/dataTypes/sleep/dataPoints/44598780531');
    expect(night.session).not.toHaveProperty('meta');
    expect(night.stagesProcessed).toBe(true);

    // 1 s HR → per-minute mean, oldest first.
    expect(night.heartRate![0]).toEqual({ tsUtc: '2026-07-03T20:30:00.000Z', value: 57 });
    expect(night.heartRate!.map((h) => h.tsUtc)).toEqual([...night.heartRate!.map((h) => h.tsUtc)].sort());
    expect(night.heartRate).toHaveLength(4);
    expect(heartRateMotion).toEqual([
      { tsUtc: '2026-07-03T20:30:00.000Z', value: 0 },
      { tsUtc: '2026-07-03T21:00:00.000Z', value: 0 },
      { tsUtc: '2026-07-04T01:38:00.000Z', value: 1 },
    ]);

    expect(night.hrv).toEqual([
      { tsUtc: '2026-07-03T20:50:00.000Z', rmssdMs: 48.2, sdnnMs: 61 },
      { tsUtc: '2026-07-03T21:00:00.000Z', rmssdMs: 55.9 },
      { tsUtc: '2026-07-03T21:10:00.000Z', rmssdMs: 51.3, sdnnMs: 64.2 },
    ]);
    expect(night.dailyHrv).toEqual({ rmssdMs: 46.7, deepSleepRmssdMs: 53.1, nonRemHrBpm: 55 });
    expect(night.restingHrBpm).toBe(57); // int64 string → number
    expect(night.spo2!.map((s) => s.value)).toEqual([96.4, 95.8, 97.1]);
    expect(night.dailySpo2).toEqual({ avgPct: 96.3, lowerPct: 94, upperPct: 98 });
    // Summary closest to the main session's end, not the afternoon nap.
    expect(night.respiratory).toEqual({ fullSleepBrpm: 14.2, lightBrpm: 14.4, deepBrpm: 13.1, remBrpm: 14.9 });
    expect(night.skinTempDeltaC).toBeCloseTo(0.22, 2);
    expect(night.steps).toEqual([
      { tsUtc: '2026-07-03T20:05:00.000Z', value: 12 },
      { tsUtc: '2026-07-03T20:06:00.000Z', value: 0 },
      { tsUtc: '2026-07-04T01:41:00.000Z', value: 34 },
    ]);
    expect(night.stillPeriods).toEqual([
      { startUtc: '2026-07-03T20:12:00.000Z', endUtc: '2026-07-03T22:10:00.000Z' },
      { startUtc: '2026-07-03T22:13:00.000Z', endUtc: '2026-07-04T01:35:00.000Z' },
    ]);
  });

  it('a 403 / 5xx / empty type never fails the whole fetch — errors are per type', async () => {
    const forbidden = () => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }, 403);
    const { client, fetchImpl } = fakeClient({
      steps: forbidden,
      'sedentary-period': forbidden,
      'oxygen-saturation': () => json({ error: { status: 'UNAVAILABLE', message: 'backend' } }, 503),
      'daily-sleep-temperature-derivations': () => json({}),
      'daily-respiratory-rate': () => json({ dataPoints: [] }),
    });
    const { night, errors, counts } = await fetchNightData(client, PARAMS);

    expect(errors).toEqual({
      steps: '403 PERMISSION_DENIED: Request had insufficient authentication scopes.',
      'sedentary-period': '403 PERMISSION_DENIED: Request had insufficient authentication scopes.',
      'oxygen-saturation': '503 UNAVAILABLE: backend',
    });
    expect(counts['daily-sleep-temperature-derivations']).toBe(0);
    expect(counts['daily-respiratory-rate']).toBe(0);
    expect(counts.steps).toBeUndefined();
    // Failed / empty fields are simply absent…
    expect(night.steps).toBeUndefined();
    expect(night.spo2).toBeUndefined();
    expect(night.skinTempDeltaC).toBeUndefined();
    // …everything else is still there.
    expect(night.session).toBeDefined();
    expect(night.hrv).toHaveLength(3);
    expect(night.dailySpo2?.avgPct).toBe(96.3);
    // sedentary-period unavailable → stillPeriods fall back to HR motionContext (needs ≥10 min runs; fixture has none).
    expect(night.stillPeriods).toBeUndefined();
    // 503 retried 3× before giving up.
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/oxygen-saturation/')).length).toBe(4);
  });

  it('a dead token fails every type without throwing', async () => {
    const fetchImpl = vi.fn();
    const client = new GoogleHealthClient({
      getAccessToken: async () => {
        throw new Error('not connected to Google');
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { night, errors } = await fetchNightData(client, PARAMS);
    expect(Object.keys(errors)).toHaveLength(ALL_NIGHT_DATA_TYPES.length);
    expect(errors.sleep).toBe('not connected to Google');
    expect(night).toEqual({ dateLocal: '2026-07-04', tz: 'Asia/Riyadh' });
  });

  it('paginates (heart rate at 1 s resolution spans pages)', async () => {
    const page2: GhListDataPointsResponse = {
      dataPoints: [{ heartRate: { sampleTime: { physicalTime: '2026-07-03T20:10:00Z' }, beatsPerMinute: '61' } }],
    };
    const { client, calls } = fakeClient({
      'heart-rate': (url) =>
        url.searchParams.get('pageToken') === 'p2' ? json(page2) : json({ ...FIXTURES['heart-rate'], nextPageToken: 'p2' }),
    });
    const { night, counts } = await fetchNightData(client, { ...PARAMS, types: ['heart-rate'] });
    expect(calls.map((u) => u.searchParams.get('pageToken'))).toEqual([null, 'p2']);
    expect(counts['heart-rate']).toBe(7);
    expect(night.heartRate![0]).toEqual({ tsUtc: '2026-07-03T20:10:00.000Z', value: 61 });
  });

  it('rejects inverted or oversized windows', async () => {
    const { client } = fakeClient();
    await expect(fetchNightData(client, { ...PARAMS, endUtc: PARAMS.startUtc })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchNightData(client, { ...PARAMS, endUtc: '2026-08-01T00:00:00Z' })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('assembleNightData', () => {
  const ctx = { dateLocal: '2026-07-04', tz: 'Asia/Riyadh', userId: 'me', startUtc: new Date(PARAMS.startUtc), endUtc: new Date(PARAMS.endUtc) };

  it('derives stillPeriods from HR motionContext when sedentary-period is missing', () => {
    const hr: GhDataPoint[] = [];
    for (let i = 0; i < 15; i++) {
      hr.push({
        heartRate: {
          sampleTime: { physicalTime: new Date(Date.parse('2026-07-03T21:00:00Z') + i * 60_000).toISOString() },
          beatsPerMinute: '55',
          metadata: { motionContext: i === 12 ? 'ACTIVE' : 'SEDENTARY' },
        },
      });
    }
    const { night } = assembleNightData({ 'heart-rate': hr }, ctx);
    expect(night.stillPeriods).toEqual([{ startUtc: '2026-07-03T21:00:00.000Z', endUtc: '2026-07-03T21:12:00.000Z' }]);
  });

  it('marks in-progress nights (metadata.processed=false) and skips nap-only data', async () => {
    const inProgress = (await import('./__fixtures__/sleep-inprogress.json')).default as GhListDataPointsResponse;
    expect(assembleNightData({ sleep: inProgress.dataPoints }, ctx).night.stagesProcessed).toBe(false);
    const napOnly = assembleNightData({ sleep: (sleepClassic as GhListDataPointsResponse).dataPoints }, ctx).night;
    expect(napOnly.session).toBeUndefined();
  });

  it('daily respiratory rate fills fullSleepBrpm when there is no per-sleep summary', () => {
    const { night } = assembleNightData({ 'daily-respiratory-rate': FIXTURES['daily-respiratory-rate'].dataPoints }, ctx);
    expect(night.respiratory).toEqual({ fullSleepBrpm: 14.1 });
  });

  it('skin temperature without a baseline yields no delta', () => {
    const { night } = assembleNightData(
      { 'daily-sleep-temperature-derivations': [{ dailySleepTemperatureDerivations: { date: { year: 2026, month: 7, day: 4 }, nightlyTemperatureCelsius: 34 } }] },
      ctx,
    );
    expect(night.skinTempDeltaC).toBeUndefined();
  });
});

describe('heart-rate motionContext + per-minute downsampling', () => {
  it('maps ACTIVE/SEDENTARY and ignores UNSPECIFIED', () => {
    const pts = (heartRate as GhListDataPointsResponse).dataPoints!.map(mapHeartRate);
    expect(pts[0]).toMatchObject({ bpm: 72, motionContext: 'active' });
    expect(pts.at(-1)).toMatchObject({ bpm: 56, motionContext: 'sedentary' });
    expect(mapHeartRate({ heartRate: { sampleTime: { physicalTime: '2026-07-04T00:00:00Z' }, beatsPerMinute: '50', metadata: { motionContext: 'MOTION_CONTEXT_UNSPECIFIED' } } })).toEqual({
      tsUtc: '2026-07-04T00:00:00.000Z',
      bpm: 50,
    });
  });
  it('perMinuteMean buckets by UTC minute', () => {
    expect(
      perMinuteMean([
        { tsUtc: '2026-07-04T00:00:59Z', value: 50 },
        { tsUtc: '2026-07-04T00:00:01Z', value: 53 },
        { tsUtc: '2026-07-04T00:01:00Z', value: 60 },
      ]),
    ).toEqual([
      { tsUtc: '2026-07-04T00:00:00.000Z', value: 51.5 },
      { tsUtc: '2026-07-04T00:01:00.000Z', value: 60 },
    ]);
  });
});
