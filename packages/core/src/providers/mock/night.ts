import type { HrvSample, NightData, TimeInterval, TimedValue } from '../../health/types.js';
import type { SleepSample, SleepStage } from '../../types.js';
import { tzOffsetMinutes, wallTimeToUtc } from '../../util/tz.js';
import { generateNight, samplesToSession, seededRandom } from './index.js';

/**
 * Mock `NightData` — a full, physiologically plausible night built on the same
 * per-minute generator as MockSleepProvider (so stages/HR agree with the mock
 * wake engine), deterministic by seed. `drop` / `tier` remove fields to
 * emulate whichever data actually arrives from the Fitbit Air.
 */

const MINUTE_MS = 60_000;

export type MockNightField = Exclude<keyof NightData, 'dateLocal' | 'tz'>;

const ALL_FIELDS: MockNightField[] = [
  'session', 'stagesProcessed', 'heartRate', 'hrv', 'dailyHrv', 'restingHrBpm', 'spo2', 'dailySpo2',
  'respiratory', 'skinTempDeltaC', 'steps', 'stillPeriods', 'heartRateMotion', 'phoneMotion', 'mood',
];
const except = (...keep: MockNightField[]) => ALL_FIELDS.filter((f) => !keep.includes(f));

/** Data tiers we might end up with (docs/BUILD_PLAN.md: "we don't yet know which data arrives in time"). */
export const MOCK_DATA_TIERS = {
  /** Everything Google exposes for the Air. */
  full: [] as MockNightField[],
  /** Stages missing (e.g. still processing) — HR, HRV, SpO2, motion and summaries only. */
  'no-stages': ['session', 'stagesProcessed'] as MockNightField[],
  /** Only Google's nightly summaries (no per-minute series). */
  'summaries-only': ['session', 'stagesProcessed', 'heartRate', 'hrv', 'spo2', 'steps', 'stillPeriods'] as MockNightField[],
  /** Only per-minute heart rate. */
  'hr-only': except('heartRate'),
  /** Only motion proxies (steps + still periods + HR motion context). */
  'motion-only': except('steps', 'stillPeriods', 'heartRateMotion'),
  /** Nothing at all (band not worn / not synced). */
  none: [...ALL_FIELDS],
} satisfies Record<string, MockNightField[]>;

export type MockDataTier = keyof typeof MOCK_DATA_TIERS;

export interface MockNightOptions {
  /** Local date the night ends on (YYYY-MM-DD). */
  dateLocal: string;
  tz: string;
  /** Default: derived from dateLocal, so the same date always gives the same night. */
  seed?: number;
  /** Bedtime HH:MM on the evening before (default 22:30–23:30 by seed). */
  bedtimeLocal?: string;
  /** Night length (default 6.3–8.1 h by seed). */
  hours?: number;
  /** −1 (very rested) … +1 (strained): raises HR, lowers HRV, shortens the night. Default by seed (mild). */
  strain?: number;
  /** Data tier to emulate (fields removed), applied before `drop`. */
  tier?: MockDataTier;
  /** Extra fields to remove. */
  drop?: MockNightField[];
  userId?: string;
}

/** FNV-1a — stable numeric seed from a string. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function addDaysToDate(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
};

const HRV_FACTOR: Record<SleepStage, number> = { deep: 1.25, light: 1.0, rem: 0.85, awake: 0.75 };
const RESP_OFFSET: Record<SleepStage, number> = { deep: -0.9, light: 0, rem: 0.7, awake: 1.5 };

export function mockNightData(opts: MockNightOptions): NightData {
  const seed = opts.seed ?? seedFromString(opts.dateLocal);
  const rand = seededRandom(seed ^ 0x5bd1e995);
  const strain = clamp(opts.strain ?? (rand() - 0.5) * 0.8, -1, 1);
  const hours = opts.hours ?? clamp(6.3 + rand() * 1.8 - strain * 0.6, 4, 10);
  const bedMin = 22 * 60 + 30 + Math.floor(rand() * 60);
  const bedtime = opts.bedtimeLocal ?? `${String(Math.floor(bedMin / 60) % 24).padStart(2, '0')}:${String(bedMin % 60).padStart(2, '0')}`;
  const prevDate = addDaysToDate(opts.dateLocal, -1);
  // Bedtimes after midnight belong to dateLocal itself.
  const bedDate = Number(bedtime.slice(0, 2)) < 12 ? opts.dateLocal : prevDate;
  const start = wallTimeToUtc(bedDate, bedtime, opts.tz);

  const samples: SleepSample[] = generateNight(start, hours, seed).map((s) => ({
    ...s,
    heartRateBpm: s.heartRateBpm != null ? s.heartRateBpm + Math.round(strain * 3) : undefined,
  }));
  const t = (s: SleepSample) => new Date(s.tsUtc).getTime();
  const asleep = samples.filter((s) => s.stage !== 'awake');

  const session = {
    ...samplesToSession(opts.userId ?? 'me', samples, 'mock'),
    id: `mock:${opts.dateLocal}`,
    tzOffsetMin: tzOffsetMinutes(start, opts.tz),
  };

  const heartRate: TimedValue[] = samples.map((s) => ({ tsUtc: s.tsUtc, value: s.heartRateBpm! }));

  // HRV every 5 min: personal base, higher in deep, lower in REM/awake.
  const hrvBase = (38 + rand() * 18) * (1 - strain * 0.15);
  const hrv: HrvSample[] = [];
  for (let i = 0; i < samples.length; i += 5) {
    const s = samples[i]!;
    const rmssd = r1(hrvBase * HRV_FACTOR[s.stage] * (0.92 + rand() * 0.16));
    hrv.push({ tsUtc: s.tsUtc, rmssdMs: rmssd, sdnnMs: r1(rmssd * (1.2 + rand() * 0.15)) });
  }
  const stageAt = new Map(samples.map((s) => [s.tsUtc, s.stage]));
  const sleepingHrv = hrv.filter((h) => stageAt.get(h.tsUtc) !== 'awake').map((h) => h.rmssdMs!);
  const deepHrv = hrv.filter((h) => stageAt.get(h.tsUtc) === 'deep').map((h) => h.rmssdMs!);
  const nonRemHr = samples.filter((s) => s.stage === 'light' || s.stage === 'deep').map((s) => s.heartRateBpm!);

  // SpO2 per minute asleep: 95–98 %, a touch lower in REM.
  const spo2Base = 96.2 + rand() * 0.8;
  const spo2: TimedValue[] = asleep.map((s) => ({
    tsUtc: s.tsUtc,
    value: r1(clamp(spo2Base + (s.stage === 'rem' ? -0.5 : 0) + (rand() - 0.5) * 1.6, 95, 98)),
  }));
  const spo2Values = spo2.map((s) => s.value);

  // Breathing ~14 brpm: slower in deep, faster in REM.
  const respBase = 13.4 + rand() * 1.2 + strain * 0.4;
  const stageMinutes = (st: SleepStage) => samples.filter((s) => s.stage === st).length;
  const brpm = (st: SleepStage) => r1(respBase + RESP_OFFSET[st]);
  const sleptMin = asleep.length;
  const full = r1((['light', 'deep', 'rem'] as SleepStage[]).reduce((sum, st) => sum + brpm(st) * stageMinutes(st), 0) / Math.max(1, sleptMin));

  // Steps per minute: some before bed, 0 asleep, a rare bathroom trip, walking after wake.
  const steps: TimedValue[] = [];
  for (let i = 10; i >= 1; i--) steps.push({ tsUtc: new Date(start.getTime() - i * MINUTE_MS).toISOString(), value: Math.floor(rand() * 25) });
  let tripLeft = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    let v = 0;
    const midNight = i > 30 && i < samples.length - 5;
    if (s.stage === 'awake' && midNight && (tripLeft > 0 || rand() < 0.08)) {
      tripLeft = tripLeft > 0 ? tripLeft - 1 : 1;
      v = 8 + Math.floor(rand() * 20);
    }
    steps.push({ tsUtc: s.tsUtc, value: v });
  }
  const endMs = t(samples[samples.length - 1]!) + MINUTE_MS;
  for (let i = 0; i < 20; i++) steps.push({ tsUtc: new Date(endMs + i * MINUTE_MS).toISOString(), value: 15 + Math.floor(rand() * 45) });

  const night: NightData = {
    dateLocal: opts.dateLocal,
    tz: opts.tz,
    session,
    stagesProcessed: true,
    heartRate,
    hrv,
    dailyHrv: {
      rmssdMs: r1(mean(sleepingHrv)),
      deepSleepRmssdMs: deepHrv.length ? r1(mean(deepHrv)) : undefined,
      nonRemHrBpm: Math.round(mean(nonRemHr)),
    },
    restingHrBpm: Math.round(pct(nonRemHr, 10) + 2),
    spo2,
    dailySpo2: { avgPct: r1(mean(spo2Values)), lowerPct: r1(pct(spo2Values, 5)), upperPct: r1(pct(spo2Values, 95)) },
    respiratory: { fullSleepBrpm: full, lightBrpm: brpm('light'), deepBrpm: brpm('deep'), remBrpm: brpm('rem') },
    skinTempDeltaC: Math.round(((rand() - 0.5) * 0.5 + strain * 0.15) * 100) / 100,
    steps,
    stillPeriods: stillRuns(steps),
    heartRateMotion: (() => {
      const stepAt = new Map(steps.map((x) => [x.tsUtc, x.value]));
      return samples.map((x) => ({ tsUtc: x.tsUtc, active: (stepAt.get(x.tsUtc) ?? 0) > 0 }));
    })(),
  };
  if (night.dailyHrv && night.dailyHrv.deepSleepRmssdMs === undefined) delete night.dailyHrv.deepSleepRmssdMs;

  for (const f of [...(opts.tier ? MOCK_DATA_TIERS[opts.tier] : []), ...(opts.drop ?? [])]) delete night[f];
  return night;
}

/** Runs of ≥ 10 zero-step minutes → still intervals (what `sedentary-period` reports). */
function stillRuns(steps: TimedValue[], minRunMin = 10): TimeInterval[] {
  const out: TimeInterval[] = [];
  let runStart: string | undefined;
  let runLen = 0;
  const close = (endIso: string) => {
    if (runStart && runLen >= minRunMin) out.push({ startUtc: runStart, endUtc: endIso });
    runStart = undefined;
    runLen = 0;
  };
  for (const s of steps) {
    if (s.value === 0) {
      runStart ??= s.tsUtc;
      runLen++;
    } else close(s.tsUtc);
  }
  const last = steps[steps.length - 1];
  if (last) close(new Date(new Date(last.tsUtc).getTime() + MINUTE_MS).toISOString());
  return out;
}

export interface MockHistoryOptions {
  /** Local date of the newest night (no clocks in core — the caller passes "today"). */
  endDateLocal: string;
  tz: string;
  seed?: number;
  tier?: MockDataTier;
  drop?: MockNightField[];
  userId?: string;
}

/** `n` consecutive mock nights ending on `endDateLocal`, oldest → newest. */
export function mockHistory(n: number, opts: MockHistoryOptions): NightData[] {
  const base = opts.seed ?? 1;
  const rand = seededRandom(base);
  const out: NightData[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dateLocal = addDaysToDate(opts.endDateLocal, -i);
    // Occasional rough night (late, short, strained), otherwise mild variation.
    const rough = rand() < 0.15;
    out.push(
      mockNightData({
        dateLocal,
        tz: opts.tz,
        seed: seedFromString(`${base}:${dateLocal}`),
        strain: rough ? 0.6 + rand() * 0.4 : (rand() - 0.5) * 0.8,
        ...(rough ? { bedtimeLocal: '00:40', hours: 5 + rand() } : {}),
        tier: opts.tier,
        drop: opts.drop,
        userId: opts.userId,
      }),
    );
  }
  return out;
}
