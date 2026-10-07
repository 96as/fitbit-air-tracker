/**
 * Small numeric + time helpers for the metric engine. Pure, platform-neutral.
 * Parsing given ISO strings is fine; we never read the wall clock here.
 */
import type { Confidence } from '../health/types.js';
import { tzOffsetMinutes } from '../util/tz.js';

export const MIN_MS = 60_000;
export const DAY_MIN = 1440;

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

/** Round to `d` decimals (default 0). */
export const round = (x: number, d = 0): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function mean(xs: number[]): number | undefined {
  const v = xs.filter(isNum);
  if (v.length === 0) return undefined;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function quantile(xs: number[], q: number): number | undefined {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export const median = (xs: number[]): number | undefined => quantile(xs, 0.5);

export function sd(xs: number[]): number | undefined {
  const v = xs.filter(isNum);
  if (v.length < 2) return undefined;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Robust SD estimate: 1.4826 × median absolute deviation. */
export function robustSd(xs: number[]): number | undefined {
  const m = median(xs);
  if (m === undefined) return undefined;
  return median(xs.filter(isNum).map((x) => Math.abs(x - m)))! * 1.4826;
}

/** Pearson correlation; undefined when n < 3 or a series is constant. */
export function pearson(xs: number[], ys: number[]): number | undefined {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return undefined;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return undefined;
  return sxy / Math.sqrt(sxx * syy);
}

export const ms = (iso: string): number => Date.parse(iso);
export const iso = (t: number): string => new Date(t).toISOString();

/** Day number for a YYYY-MM-DD date (for date arithmetic only). */
export function dayNumber(dateLocal: string): number {
  const [y, m, d] = dateLocal.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/** Minutes after local midnight for an instant, in [0, 1440). */
export function localMinuteOfDay(isoUtc: string, tz: string): number {
  const t = ms(isoUtc);
  const local = t / MIN_MS + tzOffsetMinutes(new Date(t), tz);
  return ((Math.floor(local) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/** Bedtime as minutes from local midnight; evening times become negative (22:30 → −90). */
export function bedtimeMinutes(isoUtc: string, tz: string): number {
  const m = localMinuteOfDay(isoUtc, tz);
  return m >= 12 * 60 ? m - DAY_MIN : m;
}

export const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

export function downgrade(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

/** "7 h 05 min" style duration for explanations. */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`;
}

/** HH:MM for minutes after midnight (negative allowed). */
export function fmtClock(minOfDay: number): string {
  const m = ((Math.round(minOfDay) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Linear 0–100 score: 100 at/after `good`, 0 at/before `bad` (works in either direction). */
export function linScore(x: number, bad: number, good: number): number {
  return clamp((x - bad) / (good - bad)) * 100;
}
