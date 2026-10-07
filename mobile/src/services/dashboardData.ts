import { useMemo } from 'react';
import {
  addDays,
  generateNight,
  localDateString,
  samplesToSession,
  wallTimeToUtc,
  type Baselines,
  type Confidence,
  type MetricResult,
  type MetricsReport,
  type MoodEntry,
  type NightData,
} from '@fitbit-air-tracker/core';
import { useStore } from '../store';
import { moodsOnDate, useMoodStore } from '../moodStore';

/**
 * The ONE seam between the dashboards (Today / Trends / Mood) and the data.
 *
 * Screens only ever call `useDashboardData()`. Today it is backed by realistic
 * fixtures (30 nights, some fields missing on purpose, several methods per
 * metric + a `best`). To go live, change `useNightSource()` below — nothing
 * else in the UI needs to know.
 *
 * Value conventions the UI assumes (keep the metric engine aligned):
 *   sleepDuration, sleepDebt ............ minutes
 *   sleepScore, recovery, consistency,
 *   fajrWakeEase ........................ 0–100 (higher = better)
 *   breathing ........................... breaths/min; optional components
 *                                         { baselineBrpm, spo2AvgPct, spo2BaselinePct }
 *   skinTemp ............................ °C deviation from your baseline
 *   moodLink ............................ mood points (1–5 scale) gained after
 *                                         well-slept nights; may be negative
 *   sleepDebt.components.needMin ........ personal sleep need (minutes), optional
 */

export type DashboardSource = 'fixture' | 'live';

export interface DashboardData {
  /** Oldest → newest. `mood` is filled from the mood store. */
  nights: NightData[];
  /** Same order/length as `nights` (one report per night). */
  reports: MetricsReport[];
  /** Report for the night that ended today (local), if we have it yet. */
  today?: MetricsReport;
  /** All mood check-ins, newest first. */
  moods: MoodEntry[];
  loading: boolean;
  source: DashboardSource;
}

/** Default sleep need when the engine doesn't provide `sleepDebt.components.needMin`. */
export const DEFAULT_SLEEP_NEED_MIN = 450;

interface NightSource {
  nights: NightData[];
  reports: MetricsReport[];
  /** Synthetic check-ins to make the demo charts meaningful (fixtures only). */
  sampleMoods: MoodEntry[];
  loading: boolean;
  source: DashboardSource;
}

/**
 * >>> THE SWAP POINT <<<
 * Fixture-backed for now. When WS-A (metrics) and WS-B (`useNights`) land, replace the body with:
 *
 *   const { nights, loading } = useNights();             // mobile/src/services/health.ts
 *   const reports = useMemo(
 *     () => nights.map((n, i) => computeNightMetrics(n, nights.slice(0, i), { tz })),
 *     [nights, tz],
 *   );
 *   return { nights, reports, sampleMoods: [], loading, source: 'live' };
 *
 * (`nights` must be sorted oldest → newest. Pass mood entries into the nights
 * before computing metrics if `moodLink` needs them — see `attachMoods`.)
 */
function useNightSource(tz: string, todayLocal: string): NightSource {
  return useMemo(() => buildFixtures(tz, todayLocal), [tz, todayLocal]);
}

export function useDashboardData(): DashboardData {
  const tz = useStore((s) => s.settings.tz);
  const moodHydrated = useMoodStore((s) => s.hydrated);
  const realMoods = useMoodStore((s) => s.entries);
  const todayLocal = localDateString(new Date(), tz);
  const src = useNightSource(tz, todayLocal);

  return useMemo(() => {
    // Real check-ins always win; sample moods only fill days the user hasn't logged.
    const realDays = new Set(realMoods.map((m) => localDateString(new Date(m.tsUtc), tz)));
    const moods = [
      ...realMoods,
      ...src.sampleMoods.filter((m) => !realDays.has(localDateString(new Date(m.tsUtc), tz))),
    ].sort((a, b) => b.tsUtc.localeCompare(a.tsUtc));
    const nights = attachMoods(src.nights, moods, tz);
    const today = src.reports.find((r) => r.dateLocal === todayLocal);
    return { nights, reports: src.reports, today, moods, loading: src.loading || !moodHydrated, source: src.source };
  }, [src, realMoods, moodHydrated, tz, todayLocal]);
}

/** Fill `NightData.mood` with the check-ins logged on that night's (morning) date. */
export function attachMoods(nights: NightData[], moods: MoodEntry[], tz: string): NightData[] {
  return nights.map((n) => {
    const m = moodsOnDate(moods, n.dateLocal, tz);
    return m.length ? { ...n, mood: m } : n;
  });
}

// ---------------------------------------------------------------------------
// Fixtures — deterministic per date, shaped exactly like the shared contract.
// ---------------------------------------------------------------------------

const FIXTURE_NIGHTS = 30;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
};
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};
const mins = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

function minutesAfterMidnight(iso: string, dateLocal: string, tz: string): number {
  return Math.round(mins(wallTimeToUtc(dateLocal, '00:00', tz).toISOString(), iso));
}

/** Nights where the band was not worn, or a field didn't arrive — exercises every fallback. */
function fixtureNight(dateLocal: string, tz: string, i: number): NightData {
  const r = rng(hashSeed(dateLocal));
  const night: NightData = { dateLocal, tz };
  const daysAgo = FIXTURE_NIGHTS - 1 - i;
  if (daysAgo === 5 || daysAgo === 17) return night; // band not worn

  const prevDate = localDateString(addDays(wallTimeToUtc(dateLocal, '12:00', tz), -1), tz);
  const lateNight = r() < 0.25;
  const bedMin = 22 * 60 + 15 + Math.round(r() * 60) + (lateNight ? 70 : 0);
  const hh = String(Math.floor(bedMin / 60) % 24).padStart(2, '0');
  const mm = String(bedMin % 60).padStart(2, '0');
  const bedDate = bedMin >= 24 * 60 ? dateLocal : prevDate;
  const start = wallTimeToUtc(bedDate, `${hh}:${mm}`, tz);
  const hours = 6.4 + r() * 2.2 - (lateNight ? 0.5 : 0);
  const session = { ...samplesToSession('me', generateNight(start, hours, hashSeed(dateLocal) % 100000), 'mock'), source: 'mock' as const };
  night.session = session;
  night.stagesProcessed = true;

  const sleepQ = (hours - 6.5) / 1.5; // ~ -1 … +1
  const sick = daysAgo === 9 || daysAgo === 10;
  night.restingHrBpm = Math.round(58 - sleepQ * 2 + (r() - 0.5) * 4 + (sick ? 5 : 0));
  // HRV only started syncing ~12 nights ago → exercises "still learning your normal".
  if (daysAgo < 13 && i % 6 !== 2) {
    const rmssd = round1(44 + sleepQ * 6 + (r() - 0.5) * 10 - (sick ? 12 : 0));
    night.dailyHrv = { rmssdMs: rmssd, deepSleepRmssdMs: round1(rmssd * 1.15), nonRemHrBpm: night.restingHrBpm + 2 };
  }
  if (i % 11 !== 5) {
    const brpm = round1(14.4 + (r() - 0.5) * 0.9 + (sick ? 2.2 : 0));
    night.respiratory = { fullSleepBrpm: brpm, lightBrpm: round1(brpm + 0.3), deepBrpm: round1(brpm - 0.6), remBrpm: round1(brpm + 0.5) };
  }
  if (i % 5 !== 1) {
    const avg = round1(96.2 + (r() - 0.5) * 1.6 - (sick ? 1 : 0));
    night.dailySpo2 = { avgPct: avg, lowerPct: round1(avg - 2.5), upperPct: round1(Math.min(100, avg + 1.8)) };
  }
  if (i % 7 !== 3 && daysAgo !== 0) night.skinTempDeltaC = round1((r() - 0.5) * 0.6 + (sick ? 0.7 : 0));
  return night;
}

function fixtureMood(night: NightData, tz: string, asleepMin: number | undefined): MoodEntry | undefined {
  const r = rng(hashSeed(`mood-${night.dateLocal}`));
  if (r() < 0.2) return undefined; // skipped check-in
  const q = asleepMin != null ? (asleepMin - 400) / 60 : 0;
  const score = Math.round(clamp(3.2 + q * 0.8 + (r() - 0.5) * 1.6, 1, 5)) as MoodEntry['score'];
  const energy = Math.round(clamp(score + (r() - 0.5) * 2, 1, 5)) as NonNullable<MoodEntry['energy']>;
  const tags: string[] = [];
  if (r() < 0.75) tags.push('Prayed Fajr on time');
  if (r() < 0.35) tags.push('Gym');
  if (r() < 0.15) tags.push('Late caffeine');
  if (r() < 0.12) tags.push('Stressed');
  return {
    tsUtc: wallTimeToUtc(night.dateLocal, `0${6 + Math.floor(r() * 3)}:${10 + Math.floor(r() * 40)}`, tz).toISOString(),
    score,
    energy,
    tags,
  };
}

function result(
  metric: string,
  method: string,
  value: number | null,
  confidence: Confidence,
  inputsUsed: string[],
  explanation: string,
  unit?: string,
  components?: Record<string, number>,
): MetricResult {
  return { metric, method, value, unit, confidence, inputsUsed, explanation, components };
}

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function pickBest(results: MetricResult[]): MetricResult | undefined {
  const valued = results.filter((x) => x.value != null);
  const pool = valued.length ? valued : results;
  return [...pool].sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence])[0];
}

function asleepMinutes(n: NightData): number | undefined {
  if (!n.session) return undefined;
  return n.session.stages.filter((s) => s.stage !== 'awake').reduce((a, s) => a + mins(s.startUtc, s.endUtc), 0);
}

function fixtureReport(n: NightData, history: NightData[]): MetricsReport {
  const prior = history.slice(-30);
  const asleep = (x: NightData) => asleepMinutes(x);
  const baselines: Baselines = {
    nights: prior.filter((x) => x.session).length,
    restingHrBpm: median(prior.flatMap((x) => (x.restingHrBpm != null ? [x.restingHrBpm] : []))),
    rmssdMs: median(prior.flatMap((x) => (x.dailyHrv?.rmssdMs != null ? [x.dailyHrv.rmssdMs] : []))),
    respiratoryBrpm: median(prior.flatMap((x) => (x.respiratory?.fullSleepBrpm != null ? [x.respiratory.fullSleepBrpm] : []))),
    spo2AvgPct: median(prior.flatMap((x) => (x.dailySpo2 ? [x.dailySpo2.avgPct] : []))),
    sleepMinutes: median(prior.flatMap((x) => (asleep(x) != null ? [asleep(x)!] : []))),
    bedtimeMin: median(prior.flatMap((x) => (x.session ? [minutesAfterMidnight(x.session.startUtc, x.dateLocal, x.tz)] : []))),
    waketimeMin: median(prior.flatMap((x) => (x.session ? [minutesAfterMidnight(x.session.endUtc, x.dateLocal, x.tz)] : []))),
    counts: {
      restingHrBpm: prior.filter((x) => x.restingHrBpm != null).length,
      rmssdMs: prior.filter((x) => x.dailyHrv?.rmssdMs != null).length,
      respiratoryBrpm: prior.filter((x) => x.respiratory?.fullSleepBrpm != null).length,
      spo2AvgPct: prior.filter((x) => x.dailySpo2 != null).length,
      sleepMinutes: prior.filter((x) => x.session).length,
      bedtimeMin: prior.filter((x) => x.session).length,
      waketimeMin: prior.filter((x) => x.session).length,
    },
  };
  const all: Record<string, MetricResult[]> = {};
  const add = (r: MetricResult) => (all[r.metric] ??= []).push(r);
  const need = DEFAULT_SLEEP_NEED_MIN;
  const s = n.session;
  const sleepMin = asleep(n);

  // sleepDuration
  if (s && sleepMin != null) {
    add(result('sleepDuration', 'stages-v1', Math.round(sleepMin), 'high', ['session.stages'], 'Time asleep, counted from your sleep stages with awake moments removed.', 'min'));
    add(result('sleepDuration', 'session-span-v1', Math.round(mins(s.startUtc, s.endUtc)), 'medium', ['session'], 'Time from falling asleep to waking up, including short awakenings.', 'min'));
  } else {
    add(result('sleepDuration', 'stages-v1', null, 'low', [], 'No sleep was recorded for this night — was the band worn?', 'min'));
  }

  // sleepScore
  if (s && sleepMin != null) {
    const stageMin = (st: string) => s.stages.filter((x) => x.stage === st).reduce((a, x) => a + mins(x.startUtc, x.endUtc), 0);
    const duration = clamp(100 - Math.max(0, need - sleepMin) * 0.5);
    const deep = clamp((stageMin('deep') / sleepMin / 0.18) * 100);
    const rem = clamp((stageMin('rem') / sleepMin / 0.22) * 100);
    const eff = clamp(((s.efficiencyPct ?? 90) - 70) * (100 / 25));
    const score = Math.round(duration * 0.6 + deep * 0.12 + rem * 0.1 + eff * 0.18);
    add(result('sleepScore', 'stages-v1', score, 'high', ['session.stages', 'session.efficiencyPct'], 'Mostly how long you slept, plus how much deep and dream (REM) sleep you got and how settled you were.', 'pts', {
      duration: Math.round(duration), deep: Math.round(deep), rem: Math.round(rem), efficiency: Math.round(eff),
    }));
    add(result('sleepScore', 'duration-only-v1', Math.round(duration * 0.9), 'low', ['session'], 'Based on how long you slept only.', 'pts'));
  }

  // recovery
  const rhrBase = baselines.restingHrBpm;
  const hrvBase = baselines.rmssdMs;
  const sleepPart = sleepMin != null ? clamp((sleepMin / need) * 100) : undefined;
  if (n.dailyHrv?.rmssdMs != null && hrvBase && n.restingHrBpm != null && rhrBase && sleepPart != null) {
    const hrvPart = clamp(50 + (n.dailyHrv.rmssdMs / hrvBase - 1) * 150);
    const rhrPart = clamp(50 - (n.restingHrBpm - rhrBase) * 8);
    add(result('recovery', 'hrv-rhr-v1', Math.round(hrvPart * 0.5 + rhrPart * 0.3 + sleepPart * 0.2), 'high',
      ['dailyHrv.rmssdMs', 'restingHrBpm', 'session'], 'Compares your heart-rate variability and resting heart rate with your normal, plus last night’s sleep.', 'pts',
      { hrv: Math.round(hrvPart), restingHr: Math.round(rhrPart), sleep: Math.round(sleepPart) }));
  }
  if (n.restingHrBpm != null && rhrBase && sleepPart != null) {
    const rhrPart = clamp(50 - (n.restingHrBpm - rhrBase) * 8);
    add(result('recovery', 'rhr-sleep-v1', Math.round(rhrPart * 0.6 + sleepPart * 0.4), 'medium', ['restingHrBpm', 'session'],
      'Compares your resting heart rate with your normal, plus last night’s sleep.', 'pts', { restingHr: Math.round(rhrPart), sleep: Math.round(sleepPart) }));
  }
  if (sleepPart != null) {
    add(result('recovery', 'sleep-only-v1', Math.round(sleepPart * 0.85), 'low', ['session'], 'Based on last night’s sleep only — heart data wasn’t available.', 'pts', { sleep: Math.round(sleepPart) }));
  }

  // sleepDebt (last 14 nights incl. this one)
  const window = [...history.slice(-13), n];
  const known = window.map(asleep).filter((x): x is number => x != null);
  if (known.length >= 3) {
    // Newest night counts fully, each older night 15% less; extra sleep pays debt back.
    const debt14 = Math.max(0, [...known].reverse().reduce((a, m, k) => a + 0.85 ** k * (need - m), 0));
    add(result('sleepDebt', 'rolling-14d-v1', Math.round(debt14), 'medium', ['session'],
      `Sleep you missed against a ${Math.round(need / 6) / 10}-hour need over the last two weeks; recent nights count most and extra sleep pays it back.`, 'min', { needMin: need, nights: known.length }));
    const last7 = known.slice(-7);
    add(result('sleepDebt', 'last-7d-v1', Math.round(last7.reduce((a, m) => a + Math.max(0, need - m), 0)), 'low', ['session'],
      'Sleep you missed over the last 7 nights only.', 'min', { needMin: need, nights: last7.length }));
  }

  // consistency (bedtime/wake spread, last 7)
  const last7 = [...history.slice(-6), n].filter((x) => x.session);
  if (last7.length >= 4) {
    const bed = last7.map((x) => minutesAfterMidnight(x.session!.startUtc, x.dateLocal, x.tz));
    const wake = last7.map((x) => minutesAfterMidnight(x.session!.endUtc, x.dateLocal, x.tz));
    const bedSd = sd(bed);
    const wakeSd = sd(wake);
    add(result('consistency', 'bedtime-spread-v1', Math.round(clamp(100 - ((bedSd + wakeSd) / 2 - 10) * 1.4)), last7.length >= 6 ? 'high' : 'medium',
      ['session'], 'How close your bedtimes and wake times were to each other this week.', 'pts', { bedtimeSdMin: Math.round(bedSd), waketimeSdMin: Math.round(wakeSd) }));
  }

  // breathing
  if (n.respiratory?.fullSleepBrpm != null) {
    add(result('breathing', 'respiratory-v1', n.respiratory.fullSleepBrpm, 'high', ['respiratory.fullSleepBrpm', ...(n.dailySpo2 ? ['dailySpo2'] : [])],
      'Your average breathing rate across the night, from the band.', 'brpm', {
        ...(baselines.respiratoryBrpm != null ? { baselineBrpm: round1(baselines.respiratoryBrpm) } : {}),
        ...(n.dailySpo2 ? { spo2AvgPct: n.dailySpo2.avgPct } : {}),
        ...(baselines.spo2AvgPct != null ? { spo2BaselinePct: round1(baselines.spo2AvgPct) } : {}),
      }));
    const st = [n.respiratory.lightBrpm, n.respiratory.deepBrpm, n.respiratory.remBrpm].filter((x): x is number => x != null);
    if (st.length) add(result('breathing', 'stage-avg-v1', round1(st.reduce((a, b) => a + b, 0) / st.length), 'medium', ['respiratory'], 'Average of your breathing rate in light, deep and REM sleep.', 'brpm'));
  } else if (n.dailySpo2) {
    add(result('breathing', 'respiratory-v1', null, 'low', [], 'Breathing rate hasn’t arrived from the band yet.', 'brpm', {
      spo2AvgPct: n.dailySpo2.avgPct, ...(baselines.spo2AvgPct != null ? { spo2BaselinePct: round1(baselines.spo2AvgPct) } : {}),
    }));
  }

  // skinTemp
  if (n.skinTempDeltaC != null) {
    add(result('skinTemp', 'delta-v1', n.skinTempDeltaC, 'high', ['skinTempDeltaC'], 'Change in skin temperature compared with your usual nights.', '°C'));
  }

  // fajrWakeEase — stage you were in at wake-up
  if (s) {
    const lastStage = [...s.stages].reverse().find((x) => x.stage !== 'awake')?.stage;
    const v = lastStage === 'light' ? 85 : lastStage === 'rem' ? 62 : lastStage === 'deep' ? 30 : 50;
    add(result('fajrWakeEase', 'stage-at-wake-v1', v, 'medium', ['session.stages'], 'Waking from light sleep feels easiest; waking from deep sleep feels groggy.', 'pts'));
  }

  // moodLink — mood after well-slept vs short nights (needs mood in history)
  const pairs = [...history, n].flatMap((x) => {
    const m = x.mood?.[0]?.score;
    const a = asleep(x);
    return m != null && a != null ? [{ m, long: a >= 7 * 60 }] : [];
  });
  const longs = pairs.filter((p) => p.long);
  const shorts = pairs.filter((p) => !p.long);
  if (longs.length >= 3 && shorts.length >= 3) {
    const avg = (xs: { m: number }[]) => xs.reduce((a, x) => a + x.m, 0) / xs.length;
    const diff = round1(avg(longs) - avg(shorts));
    add(result('moodLink', 'sleep-mood-v1', diff, pairs.length >= 14 ? 'medium' : 'low', ['session', 'mood'],
      diff >= 0
        ? `After 7+ hours of sleep you rated your mood ${diff} points higher on average.`
        : `Your mood hasn’t been better after longer sleep so far (${diff} points).`, 'pts', { pairs: pairs.length }));
  }

  for (const rs of Object.values(all)) for (const r of rs) r.label = fixtureLabel(r);
  const best: Record<string, MetricResult> = {};
  for (const [k, rs] of Object.entries(all)) {
    const b = pickBest(rs);
    if (b) best[k] = b;
  }
  return { dateLocal: n.dateLocal, all, best, baselines };
}

/** ≤3-word plain status, mirroring what the metric engine (WS-A) sets in `MetricResult.label`. */
function fixtureLabel(r: MetricResult): string | undefined {
  const v = r.value;
  if (v == null) return undefined;
  const score = () => (v >= 85 ? 'Great' : v >= 70 ? 'Good' : v >= 55 ? 'Fair' : 'Poor');
  switch (r.metric) {
    case 'sleepDuration':
      return `${Math.floor(v / 60)}h ${String(Math.round(v % 60)).padStart(2, '0')}m`;
    case 'sleepScore':
    case 'consistency':
      return score();
    case 'recovery':
      return v >= 67 ? 'Train hard' : v >= 34 ? 'Train light' : 'Rest';
    case 'sleepDebt':
      return v <= 60 ? 'Low' : v <= 180 ? 'Some' : 'High';
    case 'breathing': {
      const base = r.components?.baselineBrpm;
      return base != null && Math.abs(v - base) > 1.5 ? 'Unusual' : 'Normal for you';
    }
    case 'skinTemp':
      return v > 0.5 ? 'Elevated' : v < -0.5 ? 'Cooler' : 'Normal';
    case 'fajrWakeEase':
      return v >= 70 ? 'Easy' : v >= 45 ? 'Moderate' : 'Hard';
    case 'moodLink':
      return 'Sleep length';
    default:
      return undefined;
  }
}

function buildFixtures(tz: string, todayLocal: string): NightSource {
  const noon = wallTimeToUtc(todayLocal, '12:00', tz);
  const raw: NightData[] = [];
  for (let i = 0; i < FIXTURE_NIGHTS; i++) {
    const dateLocal = localDateString(addDays(noon, i - (FIXTURE_NIGHTS - 1)), tz);
    raw.push(fixtureNight(dateLocal, tz, i));
  }
  // Sample moods for past days only — today stays empty so "How do you feel?" shows.
  const sampleMoods = raw
    .filter((n) => n.dateLocal !== todayLocal)
    .flatMap((n) => {
      const m = fixtureMood(n, tz, asleepMinutes(n));
      return m ? [m] : [];
    });
  const nights = attachMoods(raw, sampleMoods, tz);
  const reports = nights.map((n, i) => fixtureReport(n, nights.slice(0, i)));
  return { nights, reports, sampleMoods, loading: false, source: 'fixture' };
}
