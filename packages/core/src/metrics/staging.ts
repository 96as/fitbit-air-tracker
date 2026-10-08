/**
 * Our own sleep staging for nights where Google's stages are missing.
 *
 * The Google Health API gives no raw accelerometer, so "motion" here is only
 * per-minute steps, "still while worn" intervals and (future) phone motion.
 * That is far coarser than the wrist actigraphy the classic algorithms were
 * built for, so treat these stages as estimates (see docs/METRICS.md).
 *
 * Methods, best first:
 *  - hr-motion-v1   actigraphy sleep/wake (Cole–Kripke + Webster rescoring,
 *                   adapted) then HR level/variability rules inside sleep.
 *  - hr-only-v1     HR level/variability rules relative to the night's own
 *                   distribution (wake = clearly above the night's median).
 *  - motion-only-v1 actigraphy sleep/wake only — every sleep minute is
 *                   labelled 'light' because motion cannot tell deep/REM apart.
 */
import type { SleepStage, SleepStageSegment } from '../types.js';
import type { Confidence, NightData } from '../health/types.js';
import { MIN_MS, iso, isNum, median, ms, quantile, robustSd } from './util.js';

export interface StageEstimate {
  method: string;
  confidence: Confidence;
  segments: SleepStageSegment[];
}

/** Longest window we'll analyse (guards against a whole day of samples). */
const MAX_WINDOW_MIN = 18 * 60;
const MIN_WINDOW_MIN = 60;
/** HR must cover this share of the window for HR-based methods to run. */
const MIN_HR_COVERAGE = 0.6;
/** Max HR gap (minutes) we interpolate across. */
const MAX_HR_GAP = 10;

// Activity proxy per minute, scaled so Cole–Kripke's P·ΣW·A ≥ 1 ⇒ wake works:
// ≥ 3 steps in a minute ⇒ wake; ~4+ consecutive non-still minutes ⇒ wake.
const STEP_WEIGHT = 25;
const NON_STILL_COUNT = 40;
const ACTIVITY_CAP = 400;
/** Cole et al. 1992, 1-minute epochs: weights for A(t−4) … A(t+2). */
const CK_WEIGHTS = [404, 598, 326, 441, 1408, 508, 350];
const CK_P = 0.00001;

interface Window {
  startMs: number;
  n: number;
}

function analysisWindow(night: NightData): Window | null {
  let start: number | undefined;
  let end: number | undefined;
  if (night.session) {
    start = ms(night.session.startUtc);
    end = ms(night.session.endUtc);
  } else {
    const ts: number[] = [];
    for (const s of night.heartRate ?? []) ts.push(ms(s.tsUtc));
    for (const s of night.steps ?? []) ts.push(ms(s.tsUtc));
    for (const s of night.phoneMotion ?? []) ts.push(ms(s.tsUtc));
    for (const p of night.stillPeriods ?? []) ts.push(ms(p.startUtc), ms(p.endUtc));
    const ok = ts.filter(isNum);
    if (ok.length === 0) return null;
    start = Math.min(...ok);
    end = Math.max(...ok);
  }
  if (!isNum(start) || !isNum(end)) return null;
  start = Math.floor(start / MIN_MS) * MIN_MS;
  const n = Math.min(MAX_WINDOW_MIN, Math.ceil((end - start) / MIN_MS));
  return n >= MIN_WINDOW_MIN ? { startMs: start, n } : null;
}

function minuteIndex(w: Window, isoUtc: string): number {
  const t = ms(isoUtc);
  return isNum(t) ? Math.floor((t - w.startMs) / MIN_MS) : -1;
}

/** Per-minute mean HR with short gaps linearly interpolated; null = unknown. */
function hrPerMinute(night: NightData, w: Window): (number | null)[] {
  const sum = new Array<number>(w.n).fill(0);
  const cnt = new Array<number>(w.n).fill(0);
  for (const s of night.heartRate ?? []) {
    const i = minuteIndex(w, s.tsUtc);
    if (i < 0 || i >= w.n || !isNum(s.value) || s.value < 25 || s.value > 230) continue;
    sum[i]! += s.value;
    cnt[i]! += 1;
  }
  const hr: (number | null)[] = sum.map((s, i) => (cnt[i]! > 0 ? s / cnt[i]! : null));
  let last = -1;
  for (let i = 0; i < w.n; i++) {
    if (hr[i] === null) continue;
    const gap = i - last - 1;
    if (last >= 0 && gap > 0 && gap <= MAX_HR_GAP) {
      for (let k = 1; k <= gap; k++) hr[last + k] = hr[last]! + ((hr[i]! - hr[last]!) * k) / (gap + 1);
    }
    last = i;
  }
  return hr;
}

interface MotionInputs {
  activity: number[];
  used: string[];
}

function motionPerMinute(night: NightData, w: Window): MotionInputs | null {
  const hasSteps = (night.steps?.length ?? 0) > 0;
  // An empty still list is treated as "not reported", not "moving all night".
  const hasStill = (night.stillPeriods?.length ?? 0) > 0;
  const hasPhone = (night.phoneMotion?.length ?? 0) > 0;
  if (!hasSteps && !hasStill && !hasPhone) return null;
  const used: string[] = [];
  const a = new Array<number>(w.n).fill(0);
  if (hasSteps) {
    used.push('steps');
    for (const s of night.steps!) {
      const i = minuteIndex(w, s.tsUtc);
      if (i >= 0 && i < w.n && isNum(s.value)) a[i]! += Math.max(0, s.value) * STEP_WEIGHT;
    }
  }
  if (hasStill) {
    used.push('stillPeriods');
    const still = new Array<boolean>(w.n).fill(false);
    for (const p of night.stillPeriods!) {
      const s = Math.max(0, Math.ceil((ms(p.startUtc) - w.startMs) / MIN_MS));
      const e = Math.min(w.n, Math.floor((ms(p.endUtc) - w.startMs) / MIN_MS));
      for (let i = s; i < e; i++) still[i] = true;
    }
    for (let i = 0; i < w.n; i++) if (!still[i]) a[i]! += NON_STILL_COUNT;
  }
  if (hasPhone) {
    used.push('phoneMotion');
    for (const s of night.phoneMotion!) {
      const i = minuteIndex(w, s.tsUtc);
      if (i >= 0 && i < w.n && isNum(s.value)) a[i]! += Math.max(0, s.value);
    }
  }
  return { activity: a.map((x) => Math.min(ACTIVITY_CAP, x)), used };
}

/** Cole–Kripke sleep/wake (true = wake) followed by Webster's rescoring rules. */
export function actigraphyWake(activity: number[]): boolean[] {
  const n = activity.length;
  const wake = activity.map((_, t) => {
    let d = 0;
    for (let k = 0; k < CK_WEIGHTS.length; k++) {
      const j = t + k - 4;
      if (j >= 0 && j < n) d += CK_WEIGHTS[k]! * activity[j]!;
    }
    return CK_P * d >= 1;
  });
  // Webster et al. 1982: (a) after ≥4 min wake, next 1 min sleep → wake;
  // (b) after ≥10 min wake, next 3 min → wake; (c) after ≥15 min wake, next 4 min → wake;
  // (d) sleep bouts ≤6 min surrounded by ≥10 min wake → wake.
  const out = wake.slice();
  let run = 0;
  for (let t = 0; t < n; t++) {
    if (wake[t]) {
      run++;
      continue;
    }
    const rescore = run >= 15 ? 4 : run >= 10 ? 3 : run >= 4 ? 1 : 0;
    for (let k = 0; k < rescore && t + k < n && !wake[t + k]; k++) out[t + k] = true;
    run = 0;
  }
  let t = 0;
  while (t < n) {
    if (out[t]) {
      t++;
      continue;
    }
    let e = t;
    while (e < n && !out[e]) e++;
    const len = e - t;
    const before = countRun(out, t - 1, -1);
    const after = countRun(out, e, 1);
    if (len <= 6 && before >= 10 && after >= 10) for (let k = t; k < e; k++) out[k] = true;
    t = e;
  }
  return out;
}

function countRun(arr: boolean[], from: number, step: 1 | -1): number {
  let c = 0;
  for (let i = from; i >= 0 && i < arr.length && arr[i]; i += step) c++;
  return c;
}

/** Centered rolling mean / SD over non-null values. */
function rolling(xs: (number | null)[], half: number, fn: (v: number[]) => number | undefined, minN: number) {
  return xs.map((_, i) => {
    const v: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(xs.length - 1, i + half); j++) {
      const x = xs[j];
      if (x !== null && x !== undefined) v.push(x);
    }
    return v.length >= minN ? (fn(v) ?? null) : null;
  });
}

const meanFn = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sdFn = (v: number[]) => {
  const m = meanFn(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};

/**
 * HR-based stage rules. Physiology (heuristic): deep NREM = lowest, most
 * regular HR; REM = higher, more variable HR and rare in the first hour;
 * wake = HR clearly above the night's median. `asleepMask` (from motion)
 * restricts which minutes can be sleep and which form the distribution.
 */
function hrStages(hr: (number | null)[], asleepMask: boolean[] | null): SleepStage[] {
  const n = hr.length;
  const s = rolling(hr, 2, meanFn, 2);
  const v = rolling(hr, 5, sdFn, 5);
  const pool = (arr: (number | null)[]) =>
    arr.filter((x, i): x is number => x !== null && (asleepMask ? asleepMask[i]! : true));
  const sPool = pool(s);
  const vPool = pool(v);
  const med = median(sPool) ?? 60;
  const mad = Math.max(2, robustSd(sPool) ?? 2);
  const deepS = quantile(sPool, 0.25) ?? med;
  const remS = quantile(sPool, 0.55) ?? med;
  const vMed = quantile(vPool, 0.5) ?? 0;
  const vRem = quantile(vPool, 0.6) ?? 0;
  const wakeThresh = med + Math.max(asleepMask ? 15 : 10, (asleepMask ? 3.5 : 2.5) * mad);

  const out: SleepStage[] = new Array(n);
  let onset = -1;
  for (let i = 0; i < n; i++) {
    const si = s[i];
    const vi = v[i] ?? vMed;
    if (asleepMask && !asleepMask[i]) {
      out[i] = 'awake';
      continue;
    }
    if (si === null || si === undefined) {
      out[i] = onset >= 0 ? 'light' : 'awake';
      continue;
    }
    if (si >= wakeThresh) {
      out[i] = 'awake';
      continue;
    }
    if (onset < 0) onset = i;
    if (si <= deepS && vi <= vMed) out[i] = 'deep';
    else if (si >= remS && vi >= vRem && i - onset >= 60) out[i] = 'rem';
    else out[i] = 'light';
  }
  return smoothRuns(out, 3);
}

/** Absorb runs shorter than `minLen` into the preceding stage (stage flicker filter). */
function smoothRuns(stages: SleepStage[], minLen: number): SleepStage[] {
  const out = stages.slice();
  let i = 0;
  while (i < out.length) {
    let e = i;
    while (e < out.length && out[e] === out[i]) e++;
    if (e - i < minLen) {
      const fill = i > 0 ? out[i - 1]! : e < out.length ? out[e]! : out[i]!;
      for (let k = i; k < e; k++) out[k] = fill;
    }
    i = e;
  }
  return out;
}

function toSegments(stages: SleepStage[], w: Window): SleepStageSegment[] {
  const segs: SleepStageSegment[] = [];
  let i = 0;
  while (i < stages.length) {
    let e = i;
    while (e < stages.length && stages[e] === stages[i]) e++;
    segs.push({ stage: stages[i]!, startUtc: iso(w.startMs + i * MIN_MS), endUtc: iso(w.startMs + e * MIN_MS) });
    i = e;
  }
  return segs;
}

export interface StageEstimateDetail extends StageEstimate {
  inputsUsed: string[];
}

/** Like `estimateStages` but also reports which NightData fields were used. */
export function estimateStagesDetailed(night: NightData): StageEstimateDetail | null {
  const w = analysisWindow(night);
  if (!w) return null;
  const hr = (night.heartRate?.length ?? 0) > 0 ? hrPerMinute(night, w) : null;
  const hrCoverage = hr ? hr.filter((x) => x !== null).length / w.n : 0;
  const hrOk = hr !== null && hrCoverage >= MIN_HR_COVERAGE;
  const motion = motionPerMinute(night, w);
  const base = night.session ? ['session'] : [];

  let method: string;
  let confidence: Confidence;
  let stages: SleepStage[];
  let used: string[];
  if (hrOk && motion) {
    const wake = actigraphyWake(motion.activity);
    stages = hrStages(hr, wake.map((x) => !x));
    method = 'hr-motion-v1';
    confidence = 'medium';
    used = ['heartRate', ...motion.used];
  } else if (hrOk) {
    stages = hrStages(hr, null);
    method = 'hr-only-v1';
    confidence = 'low';
    used = ['heartRate'];
  } else if (motion) {
    stages = actigraphyWake(motion.activity).map((x) => (x ? 'awake' : 'light'));
    method = 'motion-only-v1';
    confidence = 'low';
    used = motion.used;
  } else {
    return null;
  }
  if (!stages.some((s) => s !== 'awake')) return null;
  return { method, confidence, segments: toSegments(stages, w), inputsUsed: [...base, ...used] };
}

/**
 * Estimate sleep stages from HR and/or motion. Returns null when there is not
 * enough data (no HR with ≥60 % coverage and no motion inputs, a window under
 * an hour, or no sleep found).
 */
export function estimateStages(night: NightData): StageEstimate | null {
  const d = estimateStagesDetailed(night);
  return d ? { method: d.method, confidence: d.confidence, segments: d.segments } : null;
}

/** Totals derived from a stage hypnogram (Google's or ours). */
export interface StageSummary {
  windowStartUtc: string;
  onsetUtc: string;
  finalWakeUtc: string;
  asleepMin: number;
  deepMin: number;
  remMin: number;
  lightMin: number;
  /** Wake after sleep onset (min). */
  wasoMin: number;
  /** Awake bouts ≥ 3 min between onset and final wake. */
  awakenings: number;
  /** Minutes from the window start (in-bed time) to sleep onset; undefined when the window start is unknown. */
  latencyMin?: number;
  /** true when the hypnogram distinguishes deep/REM (not sleep/wake only). */
  detailed: boolean;
}

export function summarizeStages(segments: SleepStageSegment[], windowStartUtc?: string): StageSummary | null {
  const segs = segments
    .map((s) => ({ stage: s.stage, a: ms(s.startUtc), b: ms(s.endUtc) }))
    .filter((s) => isNum(s.a) && isNum(s.b) && s.b > s.a)
    .sort((x, y) => x.a - y.a);
  const sleep = segs.filter((s) => s.stage !== 'awake');
  if (sleep.length === 0) return null;
  const onset = sleep[0]!.a;
  const finalWake = sleep[sleep.length - 1]!.b;
  const start = windowStartUtc ? Math.min(ms(windowStartUtc), segs[0]!.a) : segs[0]!.a;
  const sum = (st: SleepStage) =>
    segs.filter((s) => s.stage === st).reduce((a, s) => a + (s.b - s.a) / MIN_MS, 0);
  const inner = segs.filter((s) => s.stage === 'awake' && s.a >= onset && s.b <= finalWake);
  const deepMin = sum('deep');
  const remMin = sum('rem');
  return {
    windowStartUtc: iso(start),
    onsetUtc: iso(onset),
    finalWakeUtc: iso(finalWake),
    asleepMin: sleep.reduce((a, s) => a + (s.b - s.a) / MIN_MS, 0),
    deepMin,
    remMin,
    lightMin: sum('light'),
    wasoMin: inner.reduce((a, s) => a + (s.b - s.a) / MIN_MS, 0),
    awakenings: inner.filter((s) => s.b - s.a >= 3 * MIN_MS).length,
    latencyMin: windowStartUtc ? Math.max(0, (onset - start) / MIN_MS) : undefined,
    detailed: deepMin + remMin > 0,
  };
}
