/** Metric engine public API (re-exported from '@fitbit-air-tracker/core'). */
export { computeNightMetrics, METRIC_IDS, type MetricId } from './engine.js';
export { computeBaselines, DEFAULT_BASELINE_NIGHTS, type BaselineOptions } from './baselines.js';
export { estimateStages, summarizeStages, type StageEstimate, type StageSummary } from './staging.js';
export { DEFAULT_SLEEP_NEED_MIN } from './features.js';
export { labelFor, scoreLabel, durationLabel } from './labels.js';
export type { MetricOptions } from './context.js';
