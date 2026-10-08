/**
 * Deterministic synthetic nights for the metric tests (seeded PRNG, no clock).
 * A ground-truth per-minute hypnogram drives every signal, so tests can check
 * our own staging against it. Not exported from the package barrel.
 */
import type { SleepStage, SleepStageSegment } from '../../types.js';
import type { MoodEntry, NightData, TimeInterval, TimedValue } from '../../health/types.js';
import { wallTimeToUtc } from '../../util/tz.js';

export type Field = 'stages' | 'hr' | 'hrv' | 'rhr' | 'spo2' | 'resp' | 'temp' | 'steps' | 'still' | 'mood';
export const ALL_FIELDS: Field[] = ['stages', 'hr', 'hrv', 'rhr', 'spo2', 'resp', 'temp', 'steps', 'still', 'mood'];

export const TIERS: Record<string, Field[]> = {
  everything: ALL_FIELDS,
  stagesOnly: ['stages'],
  hrOnly: ['hr'],
  motionOnly: ['steps', 'still'],
  hrSteps: ['hr', 'steps', 'still'],
  nothing: [],
};

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NightSpec {
  dateLocal: string;
  tz?: string;
  seed?: number;
  fields?: Field[];
  /** Local bedtime HH:MM on the previous evening (default 22:30). */
  bedLocal?: string;
  /** Jitter (± minutes) applied to bedtime. */
  jitterMin?: number;
  /** Target minutes asleep (default 420). */
  sleepMin?: number;
  rhr?: number;
  rmssd?: number;
  respBrpm?: number;
  spo2Avg?: number;
  tempDeltaC?: number;
  mood?: MoodEntry['score'];
  stagesProcessed?: boolean;
  /** Force this stage for every sleep minute in [fromMin, toMin) after onset. */
  forceStage?: { stage: SleepStage; fromUtc: string; toUtc: string };
}

export interface SynthNight {
  night: NightData;
  truth: { startMs: number; stages: SleepStage[] };
}

const MIN = 60_000;

function prevDate(d: string): string {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, dd! - 1)).toISOString().slice(0, 10);
}

export function addDaysLocal(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, dd! + n)).toISOString().slice(0, 10);
}

/** Ground-truth hypnogram: 10 min latency, ~90 min cycles, deep early, REM late. */
function hypnogram(r: () => number, sleepMin: number): SleepStage[] {
  const st: SleepStage[] = [];
  for (let i = 0; i < 10; i++) st.push('awake');
  let asleep = 0;
  let cycle = 0;
  while (asleep < sleepMin) {
    const deep = Math.max(5, Math.round(35 - cycle * 9 + r() * 6));
    const rem = Math.round(10 + cycle * 7 + r() * 5);
    const light1 = Math.round(25 + r() * 10);
    const light2 = Math.max(10, 90 - deep - rem - light1);
    const block: [SleepStage, number][] = [['light', light1], ['deep', deep], ['light', light2], ['rem', rem]];
    for (const [s, n] of block) for (let i = 0; i < n && asleep < sleepMin; i++, asleep++) st.push(s);
    if (cycle % 2 === 1) for (let i = 0; i < 4; i++) st.push('awake');
    cycle++;
  }
  for (let i = 0; i < 6; i++) st.push('awake');
  return st;
}

function segmentsOf(stages: SleepStage[], startMs: number): SleepStageSegment[] {
  const out: SleepStageSegment[] = [];
  let i = 0;
  while (i < stages.length) {
    let e = i;
    while (e < stages.length && stages[e] === stages[i]) e++;
    out.push({ stage: stages[i]!, startUtc: new Date(startMs + i * MIN).toISOString(), endUtc: new Date(startMs + e * MIN).toISOString() });
    i = e;
  }
  return out;
}

export function makeNight(spec: NightSpec): SynthNight {
  const tz = spec.tz ?? 'Asia/Riyadh';
  const fields = new Set(spec.fields ?? ALL_FIELDS);
  const r = rng(spec.seed ?? 1);
  const jitter = Math.round(((r() * 2 - 1) * (spec.jitterMin ?? 20)));
  const bed = wallTimeToUtc(prevDate(spec.dateLocal), spec.bedLocal ?? '22:30', tz).getTime() + jitter * MIN;
  const stages = hypnogram(r, spec.sleepMin ?? 420);
  if (spec.forceStage) {
    const a = Date.parse(spec.forceStage.fromUtc);
    const b = Date.parse(spec.forceStage.toUtc);
    for (let i = 0; i < stages.length; i++) {
      const t = bed + i * MIN;
      if (t >= a && t < b && stages[i] !== 'awake') stages[i] = spec.forceStage.stage;
    }
  }
  const end = bed + stages.length * MIN;
  const rhr = spec.rhr ?? 55;
  const night: NightData = { dateLocal: spec.dateLocal, tz };

  if (fields.has('stages')) {
    const asleep = stages.filter((s) => s !== 'awake').length;
    night.session = {
      id: `s-${spec.dateLocal}`,
      userId: 'u1',
      startUtc: new Date(bed).toISOString(),
      endUtc: new Date(end).toISOString(),
      tzOffsetMin: 180,
      isNap: false,
      efficiencyPct: Math.round((asleep / stages.length) * 100),
      source: 'mock',
      stages: segmentsOf(stages, bed),
    };
    night.stagesProcessed = spec.stagesProcessed ?? true;
  }
  // Signals cover 30 min before bed to 30 min after waking (awake, walking about).
  const pre = 30;
  const post = 30;
  const stageAt = (i: number): SleepStage => (i < 0 || i >= stages.length ? 'awake' : stages[i]!);
  if (fields.has('hr')) {
    const hr: TimedValue[] = [];
    for (let i = -pre; i < stages.length + post; i++) {
      const s = stageAt(i);
      const off = s === 'deep' ? -5 : s === 'light' ? 0 : s === 'rem' ? 5 : 18;
      const noise = s === 'rem' || s === 'awake' ? 4 : s === 'deep' ? 0.7 : 1.5;
      for (let k = 0; k < 2; k++) {
        hr.push({ tsUtc: new Date(bed + i * MIN + k * 30_000).toISOString(), value: Math.round((rhr + 3 + off + (r() * 2 - 1) * noise) * 10) / 10 });
      }
    }
    night.heartRate = hr;
  }
  if (fields.has('steps')) {
    const steps: TimedValue[] = [];
    for (let i = -pre; i < stages.length + post; i++) {
      const outside = i < 5 || i >= stages.length - 3;
      const midWake = !outside && stageAt(i) === 'awake' && r() < 0.5;
      if (outside && r() < 0.6) steps.push({ tsUtc: new Date(bed + i * MIN).toISOString(), value: Math.round(10 + r() * 40) });
      else if (midWake) steps.push({ tsUtc: new Date(bed + i * MIN).toISOString(), value: Math.round(3 + r() * 10) });
    }
    night.steps = steps;
  }
  if (fields.has('still')) {
    const still: TimeInterval[] = [];
    let i = 0;
    while (i < stages.length) {
      if (stages[i] === 'awake') {
        i++;
        continue;
      }
      let e = i;
      while (e < stages.length && stages[e] !== 'awake') e++;
      still.push({ startUtc: new Date(bed + i * MIN).toISOString(), endUtc: new Date(bed + e * MIN).toISOString() });
      i = e;
    }
    night.stillPeriods = still;
  }
  if (fields.has('hrv')) {
    const base = spec.rmssd ?? 45;
    night.hrv = Array.from({ length: 40 }, (_, k) => ({
      tsUtc: new Date(bed + (30 + k * 10) * MIN).toISOString(),
      rmssdMs: Math.round((base + (r() * 2 - 1) * 8) * 10) / 10,
    }));
    night.dailyHrv = { rmssdMs: base, deepSleepRmssdMs: base + 5, nonRemHrBpm: rhr + 2 };
  }
  if (fields.has('rhr')) night.restingHrBpm = rhr;
  if (fields.has('spo2')) {
    const avg = spec.spo2Avg ?? 96;
    night.spo2 = Array.from({ length: 60 }, (_, k) => ({
      tsUtc: new Date(bed + (20 + k * 6) * MIN).toISOString(),
      value: Math.round((avg + (r() * 2 - 1) * 1.2) * 10) / 10,
    }));
    night.dailySpo2 = { avgPct: avg, lowerPct: avg - 2, upperPct: Math.min(100, avg + 2) };
  }
  if (fields.has('resp')) {
    const b = spec.respBrpm ?? 14;
    night.respiratory = { fullSleepBrpm: b, lightBrpm: b, deepBrpm: b - 0.8, remBrpm: b + 0.8 };
  }
  if (fields.has('temp')) night.skinTempDeltaC = spec.tempDeltaC ?? Math.round((r() * 0.6 - 0.3) * 100) / 100;
  if (fields.has('mood') && spec.mood !== undefined) {
    night.mood = [{ tsUtc: new Date(end + 60 * MIN).toISOString(), score: spec.mood }];
  }
  return { night, truth: { startMs: bed, stages } };
}

/** `n` consecutive nights ending the day before `lastDate`, oldest first. */
export function makeHistory(n: number, lastDate: string, fields: Field[] = ALL_FIELDS, seed = 100): NightData[] {
  const out: NightData[] = [];
  for (let i = n; i >= 1; i--) {
    const r = rng(seed + i);
    const sleepMin = Math.round(390 + r() * 90);
    out.push(
      makeNight({
        dateLocal: addDaysLocal(lastDate, -i),
        seed: seed + i * 7,
        fields,
        sleepMin,
        rhr: Math.round(54 + r() * 3),
        rmssd: Math.round(42 + r() * 8),
        respBrpm: Math.round((13.6 + r() * 0.8) * 10) / 10,
        mood: (Math.min(5, Math.max(1, Math.round((sleepMin - 360) / 30)))) as MoodEntry['score'],
      }).night,
    );
  }
  return out;
}
