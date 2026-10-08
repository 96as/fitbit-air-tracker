import type { SleepSample, SleepStage, SleepStageSegment } from '../types.js';

/**
 * Light-sleep predictor for LATE data. Fitbit Air syncs ~every 15 min, so the
 * newest stage we can see describes the past. This projects the night's own
 * sleep-cycle structure forward from the last observed stage to estimate when
 * the sleeper is (or will next be) in an easy-to-wake stage.
 *
 * Model (pure, deterministic):
 *  1. Cycle boundaries = ends of REM blocks (NREM→REM cycles, ~90 min).
 *  2. Cycle length = median of the night's complete cycles when ≥ 2 exist
 *     (personalized), else 90 min.
 *  3. Template = stage runs of the most recent complete cycle (scaled to the
 *     cycle length) — late-night cycles look like late-night cycles — or a
 *     generic late-night cycle when none is complete.
 *  4. Align: find the template run matching the last observed run's stage
 *     whose phase is closest to where the night's phase says we are; project
 *     the remainder of that run and then the template, repeating.
 *  5. Shrink every predicted window by an uncertainty margin that grows with
 *     distance from the last real data point.
 *
 * Returns `ok: false` whenever the night doesn't fit the model (no sleep yet,
 * current run far longer than any template run, stage absent from template) —
 * callers then simply fall back to the other rules / the hard deadline.
 */

const MINUTE_MS = 60_000;

export interface PredictInput {
  /** Observed stages (any order); only data at/before `lastDataUtc` is used. */
  segments: SleepStageSegment[];
  /** End of the newest real data (the sync frontier). */
  lastDataUtc: Date;
  nowUtc: Date;
  /** Stages that count as "easy to wake" (default light + awake). */
  preferredStages?: SleepStage[];
  /** How far past `nowUtc` to project windows (minutes, default 120). */
  horizonMin?: number;
  /** Default cycle length when the night has < 2 complete cycles. */
  defaultCycleMin?: number;
  /** Uncertainty margin trimmed from each window edge: base + growth × minutes past the frontier. */
  marginBaseMin?: number;
  marginGrowth?: number;
}

export interface PredictedWindow {
  startUtc: string;
  endUtc: string;
}

export type Prediction =
  | {
      ok: true;
      /** Cycle length used (minutes). */
      cycleMin: number;
      /** true = cycle length learned from ≥ 2 complete cycles tonight. */
      personalized: boolean;
      completeCycles: number;
      /** Predicted easy-to-wake windows after `lastDataUtc`, margins applied. */
      windows: PredictedWindow[];
      /** `nowUtc` lies inside one of `windows`. */
      inWindow: boolean;
      /** The window containing `nowUtc`, else the next one. */
      next?: PredictedWindow;
      /** Predicted stage at `nowUtc` (before margins). */
      stageNow: SleepStage;
    }
  | { ok: false; reason: string };

interface Run {
  stage: SleepStage;
  start: number;
  end: number;
}

const DEFAULT_TEMPLATE: Array<[SleepStage, number]> = [
  ['light', 20],
  ['deep', 15],
  ['light', 25],
  ['rem', 30],
];

/** REM pieces separated by ≤ this much non-REM belong to one REM block. */
const REM_MERGE_GAP_MIN = 10;
const MIN_CYCLE_MIN = 60;
const BRIEF_AROUSAL_MIN = 5;
const MAX_CYCLE_MIN = 150;

export function predictLightWindow(input: PredictInput): Prediction {
  const preferred = input.preferredStages ?? ['light', 'awake'];
  const horizonMin = input.horizonMin ?? 120;
  const last = input.lastDataUtc.getTime();
  const now = input.nowUtc.getTime();

  const runs = toRuns(input.segments, last);
  const onsetIdx = runs.findIndex((r) => r.stage !== 'awake');
  if (onsetIdx < 0) return { ok: false, reason: 'no-sleep-yet' };
  const sleepRuns = runs.slice(onsetIdx);
  const onset = sleepRuns[0]!.start;

  // REM blocks → cycle boundaries (completed blocks only).
  const blocks: Array<{ start: number; end: number }> = [];
  for (const r of sleepRuns) {
    if (r.stage !== 'rem') continue;
    const prev = blocks[blocks.length - 1];
    if (prev && r.start - prev.end <= REM_MERGE_GAP_MIN * MINUTE_MS) prev.end = r.end;
    else blocks.push({ start: r.start, end: r.end });
  }
  const lastRun = sleepRuns[sleepRuns.length - 1]!;
  const remOngoing = blocks.length > 0 && lastRun.stage === 'rem' && blocks[blocks.length - 1]!.end === lastRun.end;
  const boundaries = (remOngoing ? blocks.slice(0, -1) : blocks).map((b) => b.end);

  const cycles: Array<{ start: number; end: number }> = [];
  let cStart = onset;
  for (const b of boundaries) {
    cycles.push({ start: cStart, end: b });
    cStart = b;
  }
  const lengths = cycles.map((c) => (c.end - c.start) / MINUTE_MS).filter((m) => m >= MIN_CYCLE_MIN && m <= MAX_CYCLE_MIN);
  const personalized = lengths.length >= 2;

  // Template from the most recent complete cycle (a post-REM cycle when available).
  let template: Array<[SleepStage, number]> = DEFAULT_TEMPLATE;
  const lastCycle = cycles[cycles.length - 1];
  if (lastCycle && (lastCycle.end - lastCycle.start) / MINUTE_MS >= MIN_CYCLE_MIN) {
    template = mergeTemplate(
      sleepRuns
        .filter((r) => r.end > lastCycle.start && r.start < lastCycle.end)
        .map((r): [SleepStage, number] => [r.stage, (Math.min(r.end, lastCycle.end) - Math.max(r.start, lastCycle.start)) / MINUTE_MS]),
    );
  }

  let cycleMin: number;
  if (personalized) {
    // Night structure drifts: REM periods lengthen and deep sleep shrinks
    // toward morning. Carry tonight's own trend into the next cycle.
    const completed = remOngoing ? blocks.slice(0, -1) : blocks;
    const remTrend = clamp(meanDiff(completed.map((b) => (b.end - b.start) / MINUTE_MS).slice(-3)), 0, 10);
    const deepPerCycle = cycles.map((c) => minutesOf(sleepRuns, 'deep', c.start, c.end));
    const deepTrend = clamp(meanDiff(deepPerCycle.slice(-3)), -10, 0);
    template = adjustStage(adjustStage(template, 'rem', remTrend), 'deep', deepTrend);
    const trended = template.reduce((sum, [, m]) => sum + m, 0);
    cycleMin = clamp((median(lengths.slice(-3)) + remTrend + deepTrend + trended) / 2, 60, 150);
  } else {
    cycleMin = input.defaultCycleMin ?? 90;
  }
  const tTotal = template.reduce((sum, [, m]) => sum + m, 0);
  template = template.map(([st, m]) => [st, (m * cycleMin) / tTotal]);

  // Align the last observed run onto the template.
  const cls = (s: SleepStage): SleepStage => (s === 'awake' ? 'light' : s);
  const anchor = boundaries.length > 0 ? boundaries[boundaries.length - 1]! : onset;
  const runPhase = mod((lastRun.start - anchor) / MINUTE_MS, cycleMin);
  let bestIdx = -1;
  let bestDist = Infinity;
  let phase = 0;
  template.forEach(([st, m], i) => {
    if (cls(st) === cls(lastRun.stage)) {
      const d = Math.min(Math.abs(phase - runPhase), cycleMin - Math.abs(phase - runPhase));
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    phase += m;
  });
  if (bestIdx < 0) return { ok: false, reason: `stage-not-in-template:${lastRun.stage}` };
  const elapsedMin = (last - lastRun.start) / MINUTE_MS;
  const runLen = template[bestIdx]![1];
  if (elapsedMin > Math.max(2 * runLen, runLen + 20)) return { ok: false, reason: 'model-mismatch:run-too-long' };

  // Project forward from the sync frontier.
  const projected: Run[] = [];
  let t = last;
  const stopAt = Math.max(now, last) + horizonMin * MINUTE_MS;
  // A run already longer than expected is assumed to end soon — but not instantly.
  const remaining = Math.max(3, runLen - elapsedMin, 0.2 * runLen);
  projected.push({ stage: lastRun.stage, start: t, end: t + remaining * MINUTE_MS });
  t += remaining * MINUTE_MS;
  for (let i = (bestIdx + 1) % template.length; t < stopAt; i = (i + 1) % template.length) {
    const [st, m] = template[i]!;
    projected.push({ stage: st, start: t, end: t + m * MINUTE_MS });
    t += m * MINUTE_MS;
  }

  const stageNow = (projected.find((r) => now >= r.start && now < r.end) ?? projected[0]!).stage;

  // Merge preferred runs into windows, then apply the uncertainty margin.
  const raw: Array<{ start: number; end: number }> = [];
  for (const r of projected) {
    if (!preferred.includes(r.stage)) continue;
    const prev = raw[raw.length - 1];
    if (prev && prev.end === r.start) prev.end = r.end;
    else raw.push({ start: r.start, end: r.end });
  }
  const mBase = input.marginBaseMin ?? 2;
  const mGrowth = input.marginGrowth ?? 0.1;
  const margin = (x: number) => (mBase + mGrowth * Math.max(0, (x - last) / MINUTE_MS)) * MINUTE_MS;
  const windows: PredictedWindow[] = [];
  for (const w of raw) {
    // A window that starts at the frontier is a continuation of observed light: no leading margin.
    const start = w.start === last ? w.start : w.start + margin(w.start);
    const end = w.end - margin(w.end);
    if (end - start >= 3 * MINUTE_MS) windows.push({ startUtc: iso(start), endUtc: iso(end) });
  }
  const containing = windows.find((w) => now >= Date.parse(w.startUtc) && now < Date.parse(w.endUtc));
  const next = containing ?? windows.find((w) => Date.parse(w.startUtc) > now);

  return {
    ok: true,
    cycleMin: Math.round(cycleMin * 10) / 10,
    personalized,
    completeCycles: lengths.length,
    windows,
    inWindow: Boolean(containing),
    ...(next ? { next } : {}),
    stageNow,
  };
}

/** Per-minute samples → contiguous stage segments (same shape as providers produce). */
export function segmentsFromSamples(samples: SleepSample[]): SleepStageSegment[] {
  const sorted = [...samples].sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  const out: SleepStageSegment[] = [];
  for (const s of sorted) {
    const t = Date.parse(s.tsUtc);
    const end = iso(t + MINUTE_MS);
    const prev = out[out.length - 1];
    if (prev && prev.stage === s.stage && Date.parse(prev.endUtc) >= t) prev.endUtc = end;
    else out.push({ stage: s.stage, startUtc: iso(t), endUtc: end });
  }
  return out;
}

function toRuns(segments: SleepStageSegment[], lastMs: number): Run[] {
  const sorted = segments
    .map((s) => ({ stage: s.stage, start: Date.parse(s.startUtc), end: Math.min(Date.parse(s.endUtc), lastMs) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  // Brief arousals (< 5 min awake) are treated as light: both are easy to wake
  // from, and they would otherwise fragment the cycle template.
  return mergeRuns(mergeRuns(sorted).map((r) => (r.stage === 'awake' && r.end - r.start < BRIEF_AROUSAL_MIN * MINUTE_MS ? { ...r, stage: 'light' } : r)));
}

function mergeRuns(xs: Run[]): Run[] {
  const runs: Run[] = [];
  for (const r of xs) {
    const prev = runs[runs.length - 1];
    if (prev && prev.stage === r.stage && r.start - prev.end <= MINUTE_MS) prev.end = Math.max(prev.end, r.end);
    else runs.push({ ...r });
  }
  return runs;
}

function mergeTemplate(t: Array<[SleepStage, number]>): Array<[SleepStage, number]> {
  const out: Array<[SleepStage, number]> = [];
  for (const [st, m] of t) {
    if (m <= 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === st) prev[1] += m;
    else out.push([st, m]);
  }
  return out.length > 0 ? out : DEFAULT_TEMPLATE;
}

/** Total minutes of `stage` inside [from, to). */
function minutesOf(runs: Run[], stage: SleepStage, from: number, to: number): number {
  return runs
    .filter((r) => r.stage === stage)
    .reduce((sum, r) => sum + Math.max(0, Math.min(r.end, to) - Math.max(r.start, from)) / MINUTE_MS, 0);
}

/** Add `delta` minutes to the template's runs of `stage` (spread proportionally; never below 0). */
function adjustStage(t: Array<[SleepStage, number]>, stage: SleepStage, delta: number): Array<[SleepStage, number]> {
  const total = t.filter(([st]) => st === stage).reduce((sum, [, m]) => sum + m, 0);
  if (total <= 0 || delta === 0) return t;
  const k = Math.max(0, total + delta) / total;
  return mergeTemplate(t.map(([st, m]) => [st, st === stage ? m * k : m]).filter(([, m]) => (m as number) >= 1) as Array<[SleepStage, number]>);
}

/** Mean of successive differences (0 when fewer than two values). */
function meanDiff(xs: number[]): number {
  if (xs.length < 2) return 0;
  return (xs[xs.length - 1]! - xs[0]!) / (xs.length - 1);
}

const iso = (ms: number) => new Date(ms).toISOString();
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mod = (a: number, n: number) => ((a % n) + n) % n;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
