import type { SleepSample, SleepSession, SleepStage, SleepStageSegment } from '../../types.js';
import type { HrvSample, TimeInterval, TimedValue } from '../../health/types.js';
import type { GhDataPoint, GhDate, GhSleep, GhSleepStageType } from './types.js';

/** Pure mapping from Google Health API v4 shapes to our normalized model. */

const MINUTE_MS = 60_000;

export const STAGE_MAP: Record<GhSleepStageType, SleepStage> = {
  AWAKE: 'awake',
  LIGHT: 'light',
  DEEP: 'deep',
  REM: 'rem',
  ASLEEP: 'light', // classic (non-staged) sleep: treat "asleep" as light — the wakeable state
  RESTLESS: 'awake',
  SLEEP_STAGE_TYPE_UNSPECIFIED: 'light',
};

/** "10800s" (protobuf Duration) or "+03:00"/"-05:30" → minutes east of UTC. */
export function parseUtcOffsetMinutes(offset?: string): number {
  if (!offset) return 0;
  const dur = /^(-?\d+(?:\.\d+)?)s$/.exec(offset);
  if (dur) return Math.round(Number(dur[1]) / 60);
  const hm = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (hm) return (hm[1] === '-' ? -1 : 1) * (Number(hm[2]) * 60 + Number(hm[3]));
  const n = Number(offset);
  return Number.isFinite(n) ? Math.round(n / 60) : 0;
}

export interface GoogleSleepMeta {
  processed?: boolean;
  mainSleep?: boolean;
  stagesStatus?: string;
  sleepType?: GhSleep['type'];
}

export type GoogleSleepSession = SleepSession & { meta: GoogleSleepMeta };

export function mapSleep(dp: GhDataPoint, userId: string): GoogleSleepSession | undefined {
  const s = dp.sleep;
  if (!s?.interval?.startTime || !s.interval.endTime) return undefined;
  const stages: SleepStageSegment[] = (s.stages ?? [])
    .filter((st) => st.startTime && st.endTime)
    .map((st) => ({
      stage: STAGE_MAP[st.type] ?? 'light',
      startUtc: new Date(st.startTime).toISOString(),
      endUtc: new Date(st.endTime).toISOString(),
    }))
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  // A CLASSIC session without stages still covers its interval as "asleep".
  if (stages.length === 0) {
    stages.push({
      stage: 'light',
      startUtc: new Date(s.interval.startTime).toISOString(),
      endUtc: new Date(s.interval.endTime).toISOString(),
    });
  }
  const asleep = num(s.summary?.minutesAsleep);
  const inPeriod = num(s.summary?.minutesInSleepPeriod);
  return {
    id: dp.name ?? `google:${s.interval.startTime}`,
    userId,
    startUtc: new Date(s.interval.startTime).toISOString(),
    endUtc: new Date(s.interval.endTime).toISOString(),
    tzOffsetMin: parseUtcOffsetMinutes(s.interval.startUtcOffset),
    isNap: Boolean(s.metadata?.nap),
    efficiencyPct: asleep != null && inPeriod ? Math.round((asleep / inPeriod) * 1000) / 10 : undefined,
    source: 'google_health',
    stages,
    meta: {
      processed: s.metadata?.processed,
      mainSleep: s.metadata?.mainSleep,
      stagesStatus: s.metadata?.stagesStatus,
      sleepType: s.type,
    },
  };
}

export type MotionContext = 'active' | 'sedentary';

export interface HeartRateSample {
  tsUtc: string;
  bpm: number;
  /** heartRate.metadata.motionContext (ACTIVE / SEDENTARY), when Google reports it. */
  motionContext?: MotionContext;
}

export function mapHeartRate(dp: GhDataPoint): HeartRateSample | undefined {
  const hr = dp.heartRate;
  if (!hr?.sampleTime?.physicalTime) return undefined;
  const bpm = Number(hr.beatsPerMinute);
  if (!Number.isFinite(bpm)) return undefined;
  const mc = hr.metadata?.motionContext;
  const motionContext: MotionContext | undefined = mc === 'ACTIVE' ? 'active' : mc === 'SEDENTARY' ? 'sedentary' : undefined;
  return { tsUtc: new Date(hr.sampleTime.physicalTime).toISOString(), bpm, ...(motionContext ? { motionContext } : {}) };
}

/** google.type.Date → "YYYY-MM-DD" (undefined for partial dates). */
export function ghDateString(d?: GhDate): string | undefined {
  if (!d?.year || !d.month || !d.day) return undefined;
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

const iso = (t: string) => new Date(t).toISOString();

export function mapHrv(dp: GhDataPoint): HrvSample | undefined {
  const h = dp.heartRateVariability;
  if (!h?.sampleTime?.physicalTime) return undefined;
  const rmssdMs = num(h.rootMeanSquareOfSuccessiveDifferencesMilliseconds);
  const sdnnMs = num(h.standardDeviationMilliseconds);
  if (rmssdMs == null && sdnnMs == null) return undefined;
  return { tsUtc: iso(h.sampleTime.physicalTime), ...(rmssdMs != null ? { rmssdMs } : {}), ...(sdnnMs != null ? { sdnnMs } : {}) };
}

export interface DailyHrv {
  dateLocal: string;
  rmssdMs?: number;
  deepSleepRmssdMs?: number;
  nonRemHrBpm?: number;
}

export function mapDailyHrv(dp: GhDataPoint): DailyHrv | undefined {
  const d = dp.dailyHeartRateVariability;
  const dateLocal = ghDateString(d?.date);
  if (!d || !dateLocal) return undefined;
  const out: DailyHrv = { dateLocal };
  const rmssd = num(d.averageHeartRateVariabilityMilliseconds);
  const deep = num(d.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds);
  const nonRem = num(d.nonRemHeartRateBeatsPerMinute);
  if (rmssd != null) out.rmssdMs = rmssd;
  if (deep != null) out.deepSleepRmssdMs = deep;
  if (nonRem != null) out.nonRemHrBpm = nonRem;
  return out;
}

export function mapDailyRestingHr(dp: GhDataPoint): { dateLocal: string; bpm: number; method?: string } | undefined {
  const d = dp.dailyRestingHeartRate;
  const dateLocal = ghDateString(d?.date);
  const bpm = num(d?.beatsPerMinute);
  if (!dateLocal || bpm == null) return undefined;
  const method = d?.dailyRestingHeartRateMetadata?.calculationMethod;
  return { dateLocal, bpm, ...(method ? { method } : {}) };
}

export function mapSpo2(dp: GhDataPoint): TimedValue | undefined {
  const o = dp.oxygenSaturation;
  const value = num(o?.percentage);
  if (!o?.sampleTime?.physicalTime || value == null) return undefined;
  return { tsUtc: iso(o.sampleTime.physicalTime), value };
}

export function mapDailySpo2(dp: GhDataPoint): { dateLocal: string; avgPct: number; lowerPct?: number; upperPct?: number } | undefined {
  const d = dp.dailyOxygenSaturation;
  const dateLocal = ghDateString(d?.date);
  const avgPct = num(d?.averagePercentage);
  if (!dateLocal || avgPct == null) return undefined;
  const lowerPct = num(d?.lowerBoundPercentage);
  const upperPct = num(d?.upperBoundPercentage);
  return { dateLocal, avgPct, ...(lowerPct != null ? { lowerPct } : {}), ...(upperPct != null ? { upperPct } : {}) };
}

export interface RespiratorySummary {
  tsUtc: string;
  fullSleepBrpm?: number;
  lightBrpm?: number;
  deepBrpm?: number;
  remBrpm?: number;
}

export function mapRespiratorySummary(dp: GhDataPoint): RespiratorySummary | undefined {
  const r = dp.respiratoryRateSleepSummary;
  if (!r?.sampleTime?.physicalTime) return undefined;
  const out: RespiratorySummary = { tsUtc: iso(r.sampleTime.physicalTime) };
  const set = (k: Exclude<keyof RespiratorySummary, 'tsUtc'>, v?: number) => {
    const n = num(v);
    if (n != null) out[k] = n;
  };
  set('fullSleepBrpm', r.fullSleepStats?.breathsPerMinute);
  set('lightBrpm', r.lightSleepStats?.breathsPerMinute);
  set('deepBrpm', r.deepSleepStats?.breathsPerMinute);
  set('remBrpm', r.remSleepStats?.breathsPerMinute);
  return Object.keys(out).length > 1 ? out : undefined;
}

export function mapDailyRespiratory(dp: GhDataPoint): { dateLocal: string; brpm: number } | undefined {
  const d = dp.dailyRespiratoryRate;
  const dateLocal = ghDateString(d?.date);
  const brpm = num(d?.breathsPerMinute);
  return dateLocal && brpm != null ? { dateLocal, brpm } : undefined;
}

export interface SleepTemperature {
  dateLocal: string;
  nightlyC: number;
  baselineC?: number;
  /** nightly − baseline (°C) when Google has a baseline (needs ~30 nights). */
  deltaC?: number;
}

export function mapSleepTemperature(dp: GhDataPoint): SleepTemperature | undefined {
  const d = dp.dailySleepTemperatureDerivations;
  const dateLocal = ghDateString(d?.date);
  const nightlyC = num(d?.nightlyTemperatureCelsius);
  if (!dateLocal || nightlyC == null) return undefined;
  const baselineC = num(d?.baselineTemperatureCelsius);
  return {
    dateLocal,
    nightlyC,
    ...(baselineC != null ? { baselineC, deltaC: Math.round((nightlyC - baselineC) * 100) / 100 } : {}),
  };
}

/** One `steps` interval (1-minute storage resolution) → value at its start. */
export function mapSteps(dp: GhDataPoint): TimedValue | undefined {
  const st = dp.steps;
  const value = num(st?.count);
  if (!st?.interval?.startTime || value == null) return undefined;
  return { tsUtc: iso(st.interval.startTime), value };
}

export function mapSedentaryPeriod(dp: GhDataPoint): TimeInterval | undefined {
  const iv = dp.sedentaryPeriod?.interval;
  if (!iv?.startTime || !iv.endTime) return undefined;
  return { startUtc: iso(iv.startTime), endUtc: iso(iv.endTime) };
}

/**
 * Average sub-minute samples into one value per UTC minute (heart rate is
 * stored at 1 s resolution; a night at 1 s would be ~30k points). Output is
 * sorted oldest → newest; values rounded to 0.1.
 */
export function perMinuteMean(values: TimedValue[]): TimedValue[] {
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const v of values) {
    const m = Math.floor(new Date(v.tsUtc).getTime() / MINUTE_MS) * MINUTE_MS;
    const b = buckets.get(m) ?? { sum: 0, n: 0 };
    b.sum += v.value;
    b.n += 1;
    buckets.set(m, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, b]) => ({ tsUtc: new Date(m).toISOString(), value: Math.round((b.sum / b.n) * 10) / 10 }));
}

/**
 * Per-minute samples from stage segments + heart-rate readings, for the wake
 * engine. Each minute inside a session gets its stage; the nearest HR reading
 * within `hrToleranceMin` is attached. Minutes with HR but no session are
 * emitted as 'awake' only if `includeHrOnly` (default false).
 */
export function toSamples(
  sessions: SleepSession[],
  heartRate: HeartRateSample[],
  fromUtc: Date,
  toUtc?: Date,
  hrToleranceMin = 5,
): SleepSample[] {
  const hr = [...heartRate].sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  const hrTimes = hr.map((h) => new Date(h.tsUtc).getTime());
  const nearestHr = (t: number): number | undefined => {
    if (hrTimes.length === 0) return undefined;
    // binary search for insertion point
    let lo = 0;
    let hi = hrTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hrTimes[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [lo - 1, lo].filter((i) => i >= 0 && i < hrTimes.length);
    let best: number | undefined;
    let bestDist = Infinity;
    for (const i of candidates) {
      const d = Math.abs(hrTimes[i]! - t);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best != null && bestDist <= hrToleranceMin * MINUTE_MS ? hr[best]!.bpm : undefined;
  };

  const out: SleepSample[] = [];
  const from = fromUtc.getTime();
  const to = toUtc?.getTime() ?? Infinity;
  for (const session of sessions) {
    for (const seg of session.stages) {
      const start = Math.max(new Date(seg.startUtc).getTime(), from);
      const end = Math.min(new Date(seg.endUtc).getTime(), to);
      for (let t = Math.ceil(start / MINUTE_MS) * MINUTE_MS; t < end; t += MINUTE_MS) {
        const bpm = nearestHr(t);
        out.push({ tsUtc: new Date(t).toISOString(), stage: seg.stage, ...(bpm != null ? { heartRateBpm: bpm } : {}) });
      }
    }
  }
  out.sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  return out;
}

function num(v?: string | number): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
