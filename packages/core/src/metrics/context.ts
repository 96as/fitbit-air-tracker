/** Internal plumbing shared by the metric modules. */
import type { Confidence, MetricResult } from '../health/types.js';
import type { BaselineStats } from './baselines.js';
import type { NightFeatures } from './features.js';
import { CONF_RANK, isNum, round } from './util.js';

export interface MetricOptions {
  /** Nightly sleep need in minutes (default 480). */
  sleepNeedMin?: number;
  /** "Now" (ISO UTC) — used to tell an in-progress night and an unfinished Fajr window. */
  nowUtc?: string;
  /** Tonight's Fajr adhan (ISO UTC) for `fajrWakeEase`. */
  fajrUtc?: string;
  /** Baseline window in nights (default 30). */
  baselineNights?: number;
}

export interface Ctx {
  f: NightFeatures;
  /** Previous nights, oldest → newest (excluding `f`). */
  hist: NightFeatures[];
  base: BaselineStats;
  needMin: number;
  opts: MetricOptions;
}

export function mk(
  metric: string,
  method: string,
  value: number | null,
  confidence: Confidence,
  inputsUsed: string[],
  explanation: string,
  extra: { unit?: string; components?: Record<string, number | undefined>; decimals?: number } = {},
): MetricResult {
  const r: MetricResult = {
    metric,
    method,
    value: isNum(value) ? round(value, extra.decimals ?? 0) : null,
    confidence,
    inputsUsed: [...new Set(inputsUsed)].sort(),
    explanation,
  };
  if (extra.unit) r.unit = extra.unit;
  if (extra.components) {
    const c: Record<string, number> = {};
    for (const [k, v] of Object.entries(extra.components)) if (isNum(v)) c[k] = round(v, 2);
    if (Object.keys(c).length > 0) r.components = c;
  }
  return r;
}

/** Best = highest confidence among non-null results; ties go to the earlier (higher-priority) method. */
export function pickBest(results: MetricResult[]): MetricResult | undefined {
  const pool = results.some((r) => r.value !== null) ? results.filter((r) => r.value !== null) : results;
  let best: MetricResult | undefined;
  for (const r of pool) if (!best || CONF_RANK[r.confidence] > CONF_RANK[best.confidence]) best = r;
  return best;
}
