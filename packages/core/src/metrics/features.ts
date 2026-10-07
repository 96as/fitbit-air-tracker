/**
 * Per-night feature extraction shared by every metric. Each feature resolves
 * through a fixed source chain (best source first) so a night is always
 * described the same way, whichever metric asks.
 */
import type { Confidence, NightData } from '../health/types.js';
import { estimateStagesDetailed, summarizeStages, type StageEstimateDetail, type StageSummary } from './staging.js';
import { MIN_MS, clamp, isNum, linScore, mean, median, ms } from './util.js';

export const DEFAULT_SLEEP_NEED_MIN = 480;

export interface Sourced<T = number> {
  value: T;
  source: string;
  confidence: Confidence;
  inputsUsed: string[];
}

export interface NightFeatures {
  night: NightData;
  /** Google stages present and processed. */
  stagesOk: boolean;
  /** Night still in progress (opts.nowUtc before the session end) or stages still processing. */
  inProgress: boolean;
  google?: StageSummary;
  /** Our own staging (lazy; null when not enough data). */
  readonly own: StageEstimateDetail | null;
  readonly ownSummary: StageSummary | undefined;
  inBedMin?: number;
  /** Session span × efficiency when Google gives an efficiency. */
  sessionAsleepMin?: number;
  readonly asleep: Sourced | undefined;
  /** Bed/wake instants (ISO UTC) for timing metrics. */
  readonly timing: Sourced<{ bedUtc: string; wakeUtc: string }> | undefined;
  rhr?: Sourced;
  rmssd?: Sourced;
  respBrpm?: Sourced;
  spo2Avg?: Sourced;
  skinTempDeltaC?: number;
  mood?: number;
}

export function extractFeatures(night: NightData, nowUtc?: string): NightFeatures {
  const session = night.session;
  const stagesOk = !!session && session.stages.length > 0 && night.stagesProcessed !== false;
  const google = stagesOk ? (summarizeStages(session!.stages, session!.startUtc) ?? undefined) : undefined;
  const inBedMin = session ? Math.max(0, (ms(session.endUtc) - ms(session.startUtc)) / MIN_MS) : undefined;
  const eff = session?.efficiencyPct;
  const sessionAsleepMin =
    isNum(inBedMin) && isNum(eff) && eff > 0 && eff <= 100 ? (inBedMin * eff) / 100 : undefined;
  const inProgress =
    night.stagesProcessed === false ||
    (!!nowUtc && !!session && isNum(ms(nowUtc)) && ms(nowUtc) < ms(session.endUtc));

  let ownCache: StageEstimateDetail | null | undefined;
  let ownSumCache: StageSummary | undefined | null;
  const f: NightFeatures = {
    night,
    stagesOk: !!google,
    inProgress,
    google,
    get own() {
      if (ownCache === undefined) ownCache = estimateStagesDetailed(night);
      return ownCache;
    },
    get ownSummary() {
      if (ownSumCache === undefined) {
        const o = f.own;
        ownSumCache = o ? (summarizeStages(o.segments, session?.startUtc) ?? null) : null;
      }
      return ownSumCache ?? undefined;
    },
    inBedMin,
    sessionAsleepMin,
    get asleep(): Sourced | undefined {
      if (google) return { value: google.asleepMin, source: 'stages', confidence: 'high', inputsUsed: ['session'] };
      if (isNum(sessionAsleepMin))
        return { value: sessionAsleepMin, source: 'session-bounds', confidence: 'medium', inputsUsed: ['session'] };
      const os = f.ownSummary;
      if (os) return { value: os.asleepMin, source: 'own-staging', confidence: f.own!.confidence, inputsUsed: f.own!.inputsUsed };
      if (isNum(inBedMin) && inBedMin > 0)
        return { value: inBedMin, source: 'session-bounds', confidence: 'low', inputsUsed: ['session'] };
      return undefined;
    },
    get timing(): Sourced<{ bedUtc: string; wakeUtc: string }> | undefined {
      if (google)
        return { value: { bedUtc: google.onsetUtc, wakeUtc: google.finalWakeUtc }, source: 'stages', confidence: 'high', inputsUsed: ['session'] };
      if (session)
        return { value: { bedUtc: session.startUtc, wakeUtc: session.endUtc }, source: 'session-bounds', confidence: 'medium', inputsUsed: ['session'] };
      const os = f.ownSummary;
      if (os)
        return { value: { bedUtc: os.onsetUtc, wakeUtc: os.finalWakeUtc }, source: 'own-staging', confidence: 'low', inputsUsed: f.own!.inputsUsed };
      return undefined;
    },
    rhr: nightRhr(night),
    rmssd: nightRmssd(night),
    respBrpm: nightResp(night),
    spo2Avg: nightSpo2(night),
    skinTempDeltaC: isNum(night.skinTempDeltaC) ? night.skinTempDeltaC : undefined,
    mood: mean((night.mood ?? []).map((m) => m.score)),
  };
  return f;
}

function nightRhr(n: NightData): Sourced | undefined {
  if (isNum(n.restingHrBpm) && n.restingHrBpm > 25)
    return { value: n.restingHrBpm, source: 'restingHrBpm', confidence: 'high', inputsUsed: ['restingHrBpm'] };
  if (isNum(n.dailyHrv?.nonRemHrBpm))
    return { value: n.dailyHrv!.nonRemHrBpm!, source: 'dailyHrv.nonRemHrBpm', confidence: 'medium', inputsUsed: ['dailyHrv'] };
  const low = lowestSustainedHr(n);
  if (isNum(low)) return { value: low, source: 'heartRate', confidence: 'medium', inputsUsed: ['heartRate'] };
  return undefined;
}

/** Lowest 30-minute rolling mean of per-minute HR ("sleeping resting HR"). */
function lowestSustainedHr(n: NightData): number | undefined {
  const byMin = new Map<number, number[]>();
  for (const s of n.heartRate ?? []) {
    const t = ms(s.tsUtc);
    if (!isNum(t) || !isNum(s.value) || s.value < 25 || s.value > 230) continue;
    const k = Math.floor(t / MIN_MS);
    (byMin.get(k) ?? byMin.set(k, []).get(k)!).push(s.value);
  }
  const mins = [...byMin.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, mean(v)!] as const);
  if (mins.length < 20) return undefined;
  let best: number | undefined;
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < mins.length; hi++) {
    sum += mins[hi]![1];
    while (mins[hi]![0] - mins[lo]![0] >= 30) sum -= mins[lo++]![1];
    const count = hi - lo + 1;
    if (count >= 20) {
      const m = sum / count;
      if (best === undefined || m < best) best = m;
    }
  }
  return best;
}

function nightRmssd(n: NightData): Sourced | undefined {
  if (isNum(n.dailyHrv?.rmssdMs) && n.dailyHrv!.rmssdMs! > 0)
    return { value: n.dailyHrv!.rmssdMs!, source: 'dailyHrv', confidence: 'high', inputsUsed: ['dailyHrv'] };
  const m = median((n.hrv ?? []).map((h) => h.rmssdMs).filter((x): x is number => isNum(x) && x > 0));
  if (isNum(m)) return { value: m, source: 'hrv', confidence: 'medium', inputsUsed: ['hrv'] };
  return undefined;
}

function nightResp(n: NightData): Sourced | undefined {
  const r = n.respiratory;
  if (!r) return undefined;
  if (isNum(r.fullSleepBrpm))
    return { value: r.fullSleepBrpm, source: 'respiratory.fullSleepBrpm', confidence: 'high', inputsUsed: ['respiratory'] };
  const m = mean([r.lightBrpm, r.deepBrpm, r.remBrpm].filter(isNum));
  return isNum(m) ? { value: m, source: 'respiratory.stages', confidence: 'medium', inputsUsed: ['respiratory'] } : undefined;
}

function nightSpo2(n: NightData): Sourced | undefined {
  if (isNum(n.dailySpo2?.avgPct))
    return { value: n.dailySpo2!.avgPct, source: 'dailySpo2', confidence: 'medium', inputsUsed: ['dailySpo2'] };
  const m = mean((n.spo2 ?? []).map((s) => s.value).filter((x) => isNum(x) && x > 50 && x <= 100));
  return isNum(m) ? { value: m, source: 'spo2', confidence: 'medium', inputsUsed: ['spo2'] } : undefined;
}

// ---------------------------------------------------------------- scoring --

export interface ScoreParts {
  value: number;
  components: Record<string, number>;
}

/**
 * Stage-based sleep score (heuristic, modelled on consumer scores such as
 * Fitbit's duration/quality/restoration split and the AASM/NSF targets):
 * duration vs need 40 %, deep share 15 % (100 at ≥15 %), REM share 15 %
 * (100 at ≥20 %), continuity 20 % (WASO + awakenings), latency 10 % (100 at
 * ≤15 min, 0 at ≥60). Deep/REM parts are dropped and weights renormalised for
 * sleep/wake-only hypnograms.
 */
export function scoreFromSummary(s: StageSummary, needMin: number): ScoreParts {
  const parts: Record<string, [number, number]> = {
    duration: [durationScore(s.asleepMin, needMin), 0.4],
    continuity: [
      100 - clamp((s.wasoMin - 10) / 80) * 70 - clamp((s.awakenings - 2) / 8) * 30,
      0.2,
    ],
    latency: [isNum(s.latencyMin) ? linScore(s.latencyMin, 60, 15) : NaN, 0.1],
  };
  if (s.detailed && s.asleepMin > 0) {
    parts.deep = [clamp(s.deepMin / s.asleepMin / 0.15) * 100, 0.15];
    parts.rem = [clamp(s.remMin / s.asleepMin / 0.2) * 100, 0.15];
  }
  return combine(parts);
}

/** 100 at ≥ need, linear to 0 at ≤ need − 4 h; mild penalty for > need + 2.5 h. */
export function durationScore(asleepMin: number, needMin: number): number {
  const under = linScore(asleepMin, needMin - 240, needMin);
  const over = asleepMin > needMin + 150 ? clamp((asleepMin - needMin - 150) / 120) * 15 : 0;
  return Math.max(0, under - over);
}

export function combine(parts: Record<string, [number, number]>): ScoreParts {
  let w = 0;
  let total = 0;
  const components: Record<string, number> = {};
  for (const [k, [score, weight]] of Object.entries(parts)) {
    if (!isNum(score)) continue;
    const sc = clamp(score, 0, 100);
    components[k] = Math.round(sc);
    total += sc * weight;
    w += weight;
  }
  return { value: w > 0 ? total / w : 0, components };
}

/** The night's sleep score via the best available source (for recovery / mood link). */
export function bestSleepScore(f: NightFeatures, needMin: number): Sourced | undefined {
  if (f.google) return { value: scoreFromSummary(f.google, needMin).value, source: 'stages-v1', confidence: 'high', inputsUsed: ['session'] };
  const os = f.ownSummary;
  if (os)
    return { value: scoreFromSummary(os, needMin).value, source: 'own-staging-v1', confidence: f.own!.confidence, inputsUsed: f.own!.inputsUsed };
  const a = f.asleep;
  if (a) return { value: durationScore(a.value, needMin), source: 'duration-only-v1', confidence: 'low', inputsUsed: a.inputsUsed };
  return undefined;
}
