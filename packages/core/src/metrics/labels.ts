/**
 * Short plain-English status labels (≤ 3 words) for the UI. Derived from a
 * result's value and components only, so every method of a metric uses the
 * same bands. Null-valued results get no label. Thresholds: docs/METRICS.md.
 */
import type { MetricResult } from '../health/types.js';
import { isNum } from './util.js';

/** sleepScore / consistency: ≥80 Great, ≥65 Good, ≥50 Fair, else Poor. */
export function scoreLabel(score: number): string {
  return score >= 80 ? 'Great' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
}

/** "7h 05m". */
export function durationLabel(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const RECOMMENDATION = ['Rest', 'Train light', 'Train hard'];
const MOOD_FACTOR = ['Sleep length', 'Recovery', 'Sleep score'];

export function labelFor(r: MetricResult): string | undefined {
  const v = r.value;
  if (!isNum(v)) return undefined;
  const c = r.components ?? {};
  switch (r.metric) {
    case 'sleepDuration':
      return durationLabel(v);
    case 'sleepScore':
    case 'consistency':
      return scoreLabel(v);
    case 'recovery':
      return RECOMMENDATION[c.recommendation ?? (v >= 67 ? 2 : v >= 34 ? 1 : 0)];
    case 'sleepDebt':
      return v < 30 ? 'On track' : v < 180 ? 'Slightly short' : 'Sleep debt';
    case 'breathing':
      return c.unusual === 1 ? 'Unusual' : 'Normal for you';
    case 'skinTemp':
      return v >= 0.5 ? 'Elevated' : v <= -0.5 ? 'Cooler' : 'Normal';
    case 'moodLink':
      return Math.abs(v) < 0.2 || !isNum(c.strongest) ? 'No clear link' : MOOD_FACTOR[c.strongest];
    case 'fajrWakeEase':
      return v >= 70 ? 'Easy' : v >= 40 ? 'Moderate' : 'Hard';
    default:
      return undefined;
  }
}

export function withLabel(r: MetricResult): MetricResult {
  const label = labelFor(r);
  return label ? { ...r, label } : r;
}
