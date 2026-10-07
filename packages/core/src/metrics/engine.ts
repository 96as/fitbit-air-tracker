/**
 * computeNightMetrics — runs every metric method whose inputs are present,
 * then picks a `best` result per metric (confidence first, then method
 * priority = the order methods are listed in each module).
 */
import type { MetricResult, MetricsReport, NightData } from '../health/types.js';
import { baselineStats } from './baselines.js';
import { breathing, skinTemp } from './breathing.js';
import { pickBest, type Ctx, type MetricOptions } from './context.js';
import { fajrWakeEase } from './fajr.js';
import { DEFAULT_SLEEP_NEED_MIN, extractFeatures } from './features.js';
import { moodLink } from './mood.js';
import { recovery } from './recovery.js';
import { consistency, sleepDebt, sleepDuration, sleepScore } from './sleep.js';
import { isNum } from './util.js';

/** Metric ids in report order. */
export const METRIC_IDS = [
  'sleepDuration',
  'sleepScore',
  'recovery',
  'sleepDebt',
  'consistency',
  'breathing',
  'skinTemp',
  'moodLink',
  'fajrWakeEase',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/**
 * Compute every metric for `night`. `history` = previous nights (excluding
 * `night`), oldest first / newest last.
 */
export function computeNightMetrics(night: NightData, history: NightData[], opts: MetricOptions = {}): MetricsReport {
  const needMin = isNum(opts.sleepNeedMin) && opts.sleepNeedMin > 0 ? opts.sleepNeedMin : DEFAULT_SLEEP_NEED_MIN;
  const hist = history.filter((h) => h !== night && h.dateLocal !== night.dateLocal).map((h) => extractFeatures(h));
  const f = extractFeatures(night, opts.nowUtc);
  const base = baselineStats(hist, { nights: opts.baselineNights });
  const ctx: Ctx = { f, hist, base, needMin, opts };

  const all: Record<string, MetricResult[]> = {};
  const best: Record<string, MetricResult> = {};
  const add = (id: MetricId, results: MetricResult[]) => {
    if (results.length === 0) return;
    all[id] = results;
    best[id] = pickBest(results)!;
  };
  add('sleepDuration', sleepDuration(ctx));
  add('sleepScore', sleepScore(ctx));
  add('recovery', recovery(ctx, best.sleepScore));
  add('sleepDebt', sleepDebt(ctx));
  add('consistency', consistency(ctx));
  add('breathing', breathing(ctx));
  add('skinTemp', skinTemp(ctx));
  add('moodLink', moodLink(ctx));
  add('fajrWakeEase', fajrWakeEase(ctx));
  return { dateLocal: night.dateLocal, all, best, baselines: base.baselines };
}
