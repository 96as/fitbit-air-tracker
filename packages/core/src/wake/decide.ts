import type { Decision, SleepSample, SleepStage } from '../types.js';

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
}

const MINUTE_MS = 60_000;

/**
 * The smart-wake decision rule (docs/SPEC.md §4). Pure function — no IO, no
 * clocks, no randomness — so the whole policy is unit-testable and every
 * decision can be logged with its exact inputs.
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
  if (age > stalenessMs) {
    return { action: 'wait', detail: `stale-data:${Math.round(age / MINUTE_MS)}min` };
  }

  if (preferredStages.includes(newest.stage)) {
    return { action: 'fire', reason: 'light-sleep', detail: `stage:${newest.stage}` };
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

  return { action: 'wait', detail: `stage:${newest.stage}` };
}
