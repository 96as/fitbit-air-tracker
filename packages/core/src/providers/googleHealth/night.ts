import type { NightData, TimeInterval, TimedValue } from '../../health/types.js';
import type { SleepSession } from '../../types.js';
import {
  GoogleHealthApiError,
  dailyDateFilter,
  filterName,
  intervalStartFilter,
  sampleTimeFilter,
  sleepFilter,
  type GoogleHealthClient,
  type ListOptions,
} from './api.js';
import {
  mapDailyHrv,
  mapDailyRespiratory,
  mapDailyRestingHr,
  mapDailySpo2,
  mapHeartRate,
  mapHrv,
  mapRespiratorySummary,
  mapSedentaryPeriod,
  mapSleep,
  mapSleepTemperature,
  mapSpo2,
  mapSteps,
  perMinuteMean,
  type GoogleSleepSession,
  type HeartRateSample,
} from './mapping.js';
import type { GhDataPoint } from './types.js';

/**
 * One night of every Fitbit Air data type → the shared `NightData` contract.
 * Each type is fetched independently: a missing scope (403), an unsupported
 * type, a network error or an empty result for one type never fails the
 * others — failures are reported per type in `errors`.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Tightest documented query range (heart-rate rollups: 14 days). A night is far below it. */
export const MAX_NIGHT_WINDOW_MS = 14 * DAY_MS;

export type NightDataType =
  | 'sleep'
  | 'heart-rate'
  | 'heart-rate-variability'
  | 'daily-heart-rate-variability'
  | 'daily-resting-heart-rate'
  | 'oxygen-saturation'
  | 'daily-oxygen-saturation'
  | 'respiratory-rate-sleep-summary'
  | 'daily-respiratory-rate'
  | 'daily-sleep-temperature-derivations'
  | 'steps'
  | 'sedentary-period';

type FilterKind = 'sleep-end' | 'sample' | 'interval' | 'daily';

/** Data type → how it is filtered, page size, and the OAuth scope that unlocks it. */
export const NIGHT_DATA_TYPES: Record<NightDataType, { kind: FilterKind; list: ListOptions; scope: 'sleep' | 'health_metrics_and_measurements' | 'activity_and_fitness' }> = {
  sleep: { kind: 'sleep-end', list: { pageSize: 25, maxPages: 2 }, scope: 'sleep' },
  // 1 s storage resolution: 8 × 10000 covers a 22 h window.
  'heart-rate': { kind: 'sample', list: { pageSize: 10_000, maxPages: 8 }, scope: 'health_metrics_and_measurements' },
  'heart-rate-variability': { kind: 'sample', list: { pageSize: 1440, maxPages: 2 }, scope: 'health_metrics_and_measurements' },
  'daily-heart-rate-variability': { kind: 'daily', list: { pageSize: 10, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  'daily-resting-heart-rate': { kind: 'daily', list: { pageSize: 10, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  'oxygen-saturation': { kind: 'sample', list: { pageSize: 1440, maxPages: 2 }, scope: 'health_metrics_and_measurements' },
  'daily-oxygen-saturation': { kind: 'daily', list: { pageSize: 10, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  'respiratory-rate-sleep-summary': { kind: 'sample', list: { pageSize: 50, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  'daily-respiratory-rate': { kind: 'daily', list: { pageSize: 10, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  'daily-sleep-temperature-derivations': { kind: 'daily', list: { pageSize: 10, maxPages: 1 }, scope: 'health_metrics_and_measurements' },
  // 1 min storage resolution.
  steps: { kind: 'interval', list: { pageSize: 1440, maxPages: 2 }, scope: 'activity_and_fitness' },
  'sedentary-period': { kind: 'interval', list: { pageSize: 1440, maxPages: 1 }, scope: 'activity_and_fitness' },
};

export const ALL_NIGHT_DATA_TYPES = Object.keys(NIGHT_DATA_TYPES) as NightDataType[];

export interface NightFetchParams {
  /** Local date (user tz) the night ENDS on — daily summaries are keyed by it. */
  dateLocal: string;
  tz: string;
  /** Window covering the night (e.g. 18:00 the evening before → 14:00 on dateLocal). */
  startUtc: Date | string;
  endUtc: Date | string;
  userId?: string;
  /** Subset of types to fetch (default: all). */
  types?: NightDataType[];
}

export interface NightFetchResult {
  night: NightData;
  /** dataType → human-readable failure (HTTP status + Google message). Absent = OK. */
  errors: Record<string, string>;
  /** dataType → raw data points received (0 = type returned nothing for this night). */
  counts: Record<string, number>;
  /**
   * heartRate.metadata.motionContext per minute (1 = ACTIVE, 0 = SEDENTARY).
   * Not part of NightData yet (contract is frozen); also used as the
   * stillPeriods fallback when `sedentary-period` is unavailable.
   */
  heartRateMotion?: TimedValue[];
}

function addDaysToDate(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function filterForType(type: NightDataType, p: { dateLocal: string; startUtc: Date; endUtc: Date }): string {
  const kind = NIGHT_DATA_TYPES[type].kind;
  const f = filterName(type);
  switch (kind) {
    case 'sleep-end':
      return sleepFilter({ endTimeFromUtc: p.startUtc, endTimeToUtc: p.endUtc });
    case 'sample':
      return sampleTimeFilter(f, p.startUtc, p.endUtc);
    case 'interval':
      return intervalStartFilter(f, p.startUtc, p.endUtc);
    case 'daily':
      return dailyDateFilter(f, p.dateLocal, addDaysToDate(p.dateLocal, 1));
  }
}

export function describeFetchError(err: unknown): string {
  if (err instanceof GoogleHealthApiError) {
    const e = (err.body as { error?: { status?: string; message?: string } } | undefined)?.error;
    return `${err.status}${e?.status ? ` ${e.status}` : ''}${e?.message ? `: ${e.message}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function fetchNightData(client: GoogleHealthClient, params: NightFetchParams): Promise<NightFetchResult> {
  const startUtc = new Date(params.startUtc);
  const endUtc = new Date(params.endUtc);
  if (!(endUtc > startUtc)) throw new RangeError('fetchNightData: endUtc must be after startUtc');
  if (endUtc.getTime() - startUtc.getTime() > MAX_NIGHT_WINDOW_MS) throw new RangeError('fetchNightData: window exceeds the 14-day query range');
  const types = params.types ?? ALL_NIGHT_DATA_TYPES;

  const settled = await Promise.allSettled(
    types.map((type) =>
      client.listDataPoints(type, filterForType(type, { dateLocal: params.dateLocal, startUtc, endUtc }), NIGHT_DATA_TYPES[type].list),
    ),
  );
  const points: Partial<Record<NightDataType, GhDataPoint[]>> = {};
  const errors: Record<string, string> = {};
  const counts: Record<string, number> = {};
  settled.forEach((r, i) => {
    const type = types[i]!;
    if (r.status === 'fulfilled') {
      points[type] = r.value;
      counts[type] = r.value.length;
    } else {
      errors[type] = describeFetchError(r.reason);
    }
  });

  const { night, heartRateMotion } = assembleNightData(points, {
    dateLocal: params.dateLocal,
    tz: params.tz,
    userId: params.userId ?? 'me',
    startUtc,
    endUtc,
  });
  return { night, errors, counts, ...(heartRateMotion ? { heartRateMotion } : {}) };
}

const defined = <T>(x: T | undefined): x is T => x != null;
const byTs = (a: { tsUtc: string }, b: { tsUtc: string }) => a.tsUtc.localeCompare(b.tsUtc);

/** Pure: raw data points per type → NightData. Exposed for tests and the server. */
export function assembleNightData(
  points: Partial<Record<NightDataType, GhDataPoint[]>>,
  ctx: { dateLocal: string; tz: string; userId: string; startUtc: Date; endUtc: Date },
): { night: NightData; heartRateMotion?: TimedValue[] } {
  const night: NightData = { dateLocal: ctx.dateLocal, tz: ctx.tz };
  const sameDay = <T extends { dateLocal: string }>(xs: T[]) => xs.find((x) => x.dateLocal === ctx.dateLocal) ?? xs[0];

  // Sleep: the main (non-nap) session ending inside the window.
  const sessions = (points.sleep ?? []).map((dp) => mapSleep(dp, ctx.userId)).filter(defined);
  const main = pickMainSession(sessions);
  if (main) {
    const { meta, ...session } = main;
    night.session = session as SleepSession;
    night.stagesProcessed = meta.processed !== false;
  }

  // Heart rate (1 s resolution) → per-minute mean; motionContext per minute.
  const hrSamples = (points['heart-rate'] ?? []).map(mapHeartRate).filter(defined);
  let heartRateMotion: TimedValue[] | undefined;
  if (hrSamples.length > 0) {
    night.heartRate = perMinuteMean(hrSamples.map((h) => ({ tsUtc: h.tsUtc, value: h.bpm })));
    heartRateMotion = motionPerMinute(hrSamples);
  }

  const hrv = (points['heart-rate-variability'] ?? []).map(mapHrv).filter(defined).sort(byTs);
  if (hrv.length > 0) night.hrv = hrv;

  const dailyHrv = sameDay((points['daily-heart-rate-variability'] ?? []).map(mapDailyHrv).filter(defined));
  if (dailyHrv) {
    const { dateLocal: _d, ...rest } = dailyHrv;
    if (Object.keys(rest).length > 0) night.dailyHrv = rest;
  }

  const rhr = sameDay((points['daily-resting-heart-rate'] ?? []).map(mapDailyRestingHr).filter(defined));
  if (rhr) night.restingHrBpm = rhr.bpm;

  const spo2 = (points['oxygen-saturation'] ?? []).map(mapSpo2).filter(defined).sort(byTs);
  if (spo2.length > 0) night.spo2 = spo2;

  const dailySpo2 = sameDay((points['daily-oxygen-saturation'] ?? []).map(mapDailySpo2).filter(defined));
  if (dailySpo2) {
    const { dateLocal: _d, ...rest } = dailySpo2;
    night.dailySpo2 = rest;
  }

  // Respiratory: per-sleep summary (closest to the main session) with the
  // daily value as a fallback for the full-sleep rate.
  const summaries = (points['respiratory-rate-sleep-summary'] ?? []).map(mapRespiratorySummary).filter(defined);
  const summary = pickClosest(summaries, main?.endUtc ?? ctx.endUtc.toISOString());
  const dailyResp = sameDay((points['daily-respiratory-rate'] ?? []).map(mapDailyRespiratory).filter(defined));
  if (summary || dailyResp) {
    const { tsUtc: _t, ...stats } = summary ?? { tsUtc: '' };
    night.respiratory = { ...stats };
    if (night.respiratory.fullSleepBrpm == null && dailyResp) night.respiratory.fullSleepBrpm = dailyResp.brpm;
  }

  const temp = sameDay((points['daily-sleep-temperature-derivations'] ?? []).map(mapSleepTemperature).filter(defined));
  if (temp?.deltaC != null) night.skinTempDeltaC = temp.deltaC;

  const steps = (points.steps ?? []).map(mapSteps).filter(defined).sort(byTs);
  if (steps.length > 0) night.steps = steps;

  const still = (points['sedentary-period'] ?? [])
    .map(mapSedentaryPeriod)
    .filter(defined)
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  if (still.length > 0) night.stillPeriods = still;
  else if (heartRateMotion) {
    const fromHr = sedentaryRuns(heartRateMotion);
    if (fromHr.length > 0) night.stillPeriods = fromHr;
  }

  return { night, ...(heartRateMotion && heartRateMotion.length > 0 ? { heartRateMotion } : {}) };
}

function pickMainSession(sessions: GoogleSleepSession[]): GoogleSleepSession | undefined {
  const flagged = sessions.filter((s) => s.meta.mainSleep);
  const pool = flagged.length > 0 ? flagged : sessions.filter((s) => !s.isNap);
  const dur = (s: SleepSession) => new Date(s.endUtc).getTime() - new Date(s.startUtc).getTime();
  return [...pool].sort((a, b) => dur(b) - dur(a))[0];
}

function pickClosest<T extends { tsUtc: string }>(xs: T[], targetIso: string): T | undefined {
  const target = new Date(targetIso).getTime();
  let best: T | undefined;
  let bestDist = Infinity;
  for (const x of xs) {
    const d = Math.abs(new Date(x.tsUtc).getTime() - target);
    if (d < bestDist) {
      bestDist = d;
      best = x;
    }
  }
  return best;
}

/** Majority motionContext per minute: 1 = active, 0 = sedentary. */
function motionPerMinute(hr: HeartRateSample[]): TimedValue[] {
  const withCtx = hr.filter((h) => h.motionContext);
  if (withCtx.length === 0) return [];
  return perMinuteMean(withCtx.map((h) => ({ tsUtc: h.tsUtc, value: h.motionContext === 'active' ? 1 : 0 }))).map((v) => ({
    tsUtc: v.tsUtc,
    value: v.value >= 0.5 ? 1 : 0,
  }));
}

/** Runs of ≥ 10 consecutive sedentary minutes → intervals (fallback for stillPeriods). */
function sedentaryRuns(motion: TimedValue[], minRunMin = 10): TimeInterval[] {
  const out: TimeInterval[] = [];
  let runStart: number | undefined;
  let prev: number | undefined;
  const close = () => {
    if (runStart != null && prev != null && prev + MINUTE_MS - runStart >= minRunMin * MINUTE_MS) {
      out.push({ startUtc: new Date(runStart).toISOString(), endUtc: new Date(prev + MINUTE_MS).toISOString() });
    }
    runStart = undefined;
  };
  for (const m of motion) {
    const t = new Date(m.tsUtc).getTime();
    const contiguous = prev != null && t - prev <= MINUTE_MS;
    if (m.value === 0) {
      if (runStart == null || !contiguous) {
        close();
        runStart = t;
      }
    } else close();
    prev = t;
  }
  close();
  return out;
}
