import type { NightData, TimedValue } from '../health/types.js';

/**
 * Storage compaction for older nights (the phone keeps ~60 nights in
 * AsyncStorage; full per-minute series cost ~80 KB/night). Pure and
 * idempotent: compacting an already-compacted night changes nothing.
 *
 * - heartRate           → `resolutionMin` means (bucket start timestamp); inside the
 *                          night's lowest sustained 30-min stretch each mean is repeated
 *                          per minute, so "lowest 30-min HR" (resting-HR fallback) survives
 * - spo2                 → `resolutionMin` means
 * - steps, phoneMotion   → `resolutionMin` sums; all-zero buckets are dropped
 *                          (metrics treat a missing minute as 0 steps), but at
 *                          least one bucket is kept so "steps were reported" survives
 * - heartRateMotion      → dropped (full-resolution motion context only for recent nights)
 * - hrv (raw samples)    → dropped when `dailyHrv.rmssdMs` exists, else 30-min means
 * - session, stillPeriods, summaries → unchanged
 */
const MINUTE_MS = 60_000;

export function compactNight(night: NightData, resolutionMin = 5): NightData {
  const step = Math.max(1, Math.round(resolutionMin)) * MINUTE_MS;
  const out: NightData = { ...night };
  if (night.heartRate) out.heartRate = compactHeartRate(night.heartRate, step);
  if (night.spo2) out.spo2 = bucket(night.spo2, step, 'mean');
  if (night.steps) out.steps = dropZeroBuckets(bucket(night.steps, step, 'sum'));
  if (night.phoneMotion) out.phoneMotion = dropZeroBuckets(bucket(night.phoneMotion, step, 'sum'));
  delete out.heartRateMotion;
  if (night.hrv) {
    if (night.dailyHrv?.rmssdMs != null) delete out.hrv;
    else {
      const half = 30 * MINUTE_MS;
      const rmssd = bucket(night.hrv.filter((h) => h.rmssdMs != null).map((h) => ({ tsUtc: h.tsUtc, value: h.rmssdMs! })), half, 'mean');
      if (rmssd.length > 0) out.hrv = rmssd.map((v) => ({ tsUtc: v.tsUtc, rmssdMs: v.value }));
      else delete out.hrv;
    }
  }
  return out;
}

const LOW_WINDOW_MIN = 30;

function compactHeartRate(hr: TimedValue[], stepMs: number): TimedValue[] {
  const buckets = bucket(hr, stepMs, 'mean');
  const low = lowestSustainedWindow(hr);
  if (!low) return buckets;
  // Inside the (bucket-aligned) lowest stretch, repeat each bucket mean per
  // minute: same values, same mean, but enough points for a 30-min rolling mean.
  const from = Math.floor(low.start / stepMs) * stepMs;
  const to = Math.ceil(low.end / stepMs) * stepMs;
  const out: TimedValue[] = [];
  for (const b of buckets) {
    const t = Date.parse(b.tsUtc);
    if (t < from || t >= to) {
      out.push(b);
      continue;
    }
    for (let m = t; m < t + stepMs; m += MINUTE_MS) out.push({ tsUtc: new Date(m).toISOString(), value: b.value });
  }
  return out;
}

/** Lowest 30-min rolling mean of per-minute HR (≥ 20 minutes present) → its time span. */
function lowestSustainedWindow(hr: TimedValue[]): { start: number; end: number } | undefined {
  const perMin = bucket(hr, MINUTE_MS, 'mean').map((v) => ({ m: Date.parse(v.tsUtc) / MINUTE_MS, v: v.value }));
  let best: { mean: number; start: number } | undefined;
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < perMin.length; hi++) {
    sum += perMin[hi]!.v;
    while (perMin[hi]!.m - perMin[lo]!.m >= LOW_WINDOW_MIN) sum -= perMin[lo++]!.v;
    const count = hi - lo + 1;
    if (count >= 20 && (!best || sum / count < best.mean)) best = { mean: sum / count, start: perMin[lo]!.m };
  }
  if (!best) return undefined;
  return { start: best.start * MINUTE_MS, end: (best.start + LOW_WINDOW_MIN) * MINUTE_MS };
}

function bucket(values: TimedValue[], stepMs: number, mode: 'mean' | 'sum'): TimedValue[] {
  const acc = new Map<number, { sum: number; n: number }>();
  for (const v of values) {
    const t = Date.parse(v.tsUtc);
    if (!Number.isFinite(t) || !Number.isFinite(v.value)) continue;
    const k = Math.floor(t / stepMs) * stepMs;
    const b = acc.get(k) ?? { sum: 0, n: 0 };
    b.sum += v.value;
    b.n += 1;
    acc.set(k, b);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ tsUtc: new Date(k).toISOString(), value: Math.round((mode === 'mean' ? b.sum / b.n : b.sum) * 10) / 10 }));
}

function dropZeroBuckets(xs: TimedValue[]): TimedValue[] {
  const nonZero = xs.filter((x) => x.value !== 0);
  return nonZero.length > 0 ? nonZero : xs.slice(0, 1);
}
