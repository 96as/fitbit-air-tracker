import type { Decision, SleepSample, SleepStage } from '../types.js';
import { predictLightWindow, segmentsFromSamples, type Prediction } from './predict.js';

export interface DecideInput {
  now: Date;
  /** Hard deadline — the alarm must have fired by this instant. */
  deadline: Date;
  /** Stages considered "easy to wake from". */
  preferredStages: SleepStage[];
  /** Freshest telemetry visible (may trail wall time by the sync lag). */
  samples: SleepSample[];
  /** Ignore data older than this (minutes). Default 20 ≈ sync cadence + slack. */
  stalenessLimitMin?: number;
  /** Heart-rate rise over sleeping baseline that suggests imminent natural wake. */
  hrRiseThresholdBpm?: number;
  /**
   * Start of the smart-wake window. The predictor (both the 'predicted-light'
   * rule and the stale-light gate) only acts when this is given and
   * `now >= windowStart` — it can never cause an early fire.
   */
  windowStart?: Date;
  /** Whole-night samples for the cycle predictor (default: `samples`). */
  history?: SleepSample[];
  /** Enable the late-data cycle predictor. Default true. */
  predictive?: boolean;
  /**
   * When the newest stage is light but ≥ predictMinLagMin old and the
   * predictor confidently says the sleeper has since left light sleep, hold
   * off instead of firing on stale light. Default true (only when predictive).
   */
  gateStaleLight?: boolean;
  /** Predict only when the newest data is at least this old (default 5 min — fresher data is the truth). */
  predictMinLagMin?: number;
  /** …and at most this old (default 30 min). */
  predictMaxLagMin?: number;
}

const MINUTE_MS = 60_000;

/**
 * The smart-wake decision rule (docs/SPEC.md §4). Pure function — no IO, no
 * clocks, no randomness — so the whole policy is unit-testable and every
 * decision can be logged with its exact inputs.
 *
 * Order: deadline → no data → (fresh enough) light stage / HR rise →
 * late-data cycle prediction → wait.
 *
 * Invariant: once `now >= deadline` this always fires, regardless of data.
 */
export function decide(input: DecideInput): Decision {
  const { now, deadline, preferredStages, samples } = input;
  const stalenessMs = (input.stalenessLimitMin ?? 20) * MINUTE_MS;
  const hrRise = input.hrRiseThresholdBpm ?? 8;

  if (now.getTime() >= deadline.getTime()) {
    return { action: 'fire', reason: 'deadline' };
  }

  const sorted = [...samples].sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  const newest = sorted[sorted.length - 1];
  if (!newest) return { action: 'wait', detail: 'no-data' };

  const age = now.getTime() - new Date(newest.tsUtc).getTime();
  let prediction: Prediction | null | undefined; // undefined = not computed yet, null = not applicable
  const predict = () => (prediction === undefined ? (prediction = predictNow(input, newest, age)) : prediction);

  if (age <= stalenessMs) {
    if (preferredStages.includes(newest.stage)) {
      const p = input.gateStaleLight === false ? null : predict();
      const leftLight = p?.ok && !p.inWindow && !preferredStages.includes(p.stageNow);
      if (!leftLight) return { action: 'fire', reason: 'light-sleep', detail: `stage:${newest.stage}` };
    }

    // HR-rise heuristic: mean bpm over the newest 10 min vs. the sleeping
    // baseline (everything older). A clear rise suggests a natural wake is near.
    const recentCutoff = new Date(newest.tsUtc).getTime() - 10 * MINUTE_MS;
    const withHr = sorted.filter((s) => s.heartRateBpm != null);
    const recent = withHr.filter((s) => new Date(s.tsUtc).getTime() >= recentCutoff);
    const baseline = withHr.filter((s) => new Date(s.tsUtc).getTime() < recentCutoff);
    if (recent.length >= 5 && baseline.length >= 15) {
      const mean = (xs: SleepSample[]) => xs.reduce((sum, s) => sum + s.heartRateBpm!, 0) / xs.length;
      const delta = mean(recent) - mean(baseline);
      if (delta >= hrRise) {
        return { action: 'fire', reason: 'hr-rise', detail: `delta:${delta.toFixed(1)}bpm` };
      }
    }
  }

  // Late-data rule: the newest stage is ~5–30 min old, so project tonight's
  // own sleep cycles forward and fire if NOW is predicted light sleep.
  const p = predict();
  if (p?.ok && p.inWindow) {
    return {
      action: 'fire',
      reason: 'predicted-light',
      detail: `predicted:${p.stageNow} cycle:${p.cycleMin}min${p.personalized ? ' (personal)' : ''} lag:${Math.round(age / MINUTE_MS)}min`,
    };
  }

  return age > stalenessMs
    ? { action: 'wait', detail: `stale-data:${Math.round(age / MINUTE_MS)}min` }
    : { action: 'wait', detail: `stage:${newest.stage}` };
}

/** The cycle prediction for `now`, or null when the predictor must not act. */
function predictNow(input: DecideInput, newest: SleepSample, ageMs: number): Prediction | null {
  const { now, windowStart, deadline } = input;
  if (input.predictive === false || !windowStart) return null;
  if (now.getTime() < windowStart.getTime() || now.getTime() >= deadline.getTime()) return null;
  if (ageMs < (input.predictMinLagMin ?? 5) * MINUTE_MS || ageMs > (input.predictMaxLagMin ?? 30) * MINUTE_MS) return null;
  return predictLightWindow({
    segments: segmentsFromSamples(input.history ?? input.samples),
    lastDataUtc: new Date(new Date(newest.tsUtc).getTime() + MINUTE_MS),
    nowUtc: now,
    preferredStages: input.preferredStages,
  });
}
