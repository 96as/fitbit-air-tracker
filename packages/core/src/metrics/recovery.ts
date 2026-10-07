/**
 * Recovery (0–100) with a training recommendation.
 *
 * Basis: HRV-guided training (Plews et al. 2013; Kiviniemi et al. 2007) —
 * compare today's ln(rMSSD) with your rolling baseline in units of its normal
 * spread; an elevated resting HR vs baseline is a classic fatigue/illness
 * marker (Buchheit 2014). Sleep score adds the sleep component; a raised
 * nightly skin temperature is applied as a penalty (illness signal).
 */
import type { Confidence, MetricResult } from '../health/types.js';
import { baselineStats, type BaselineStats } from './baselines.js';
import { mk, pickBest, type Ctx } from './context.js';
import { bestSleepScore, combine, type NightFeatures } from './features.js';
import { clamp, isNum, linScore } from './util.js';

interface Part {
  score: number;
  confidence: Confidence;
  relative: boolean;
  phrase: string;
  inputs: string[];
}

const zToScore = (z: number) => clamp(50 + 20 * z, 0, 100);
const relConf = (n: number): Confidence => (n >= 14 ? 'high' : n >= 3 ? 'medium' : 'low');

export function hrvPart(f: NightFeatures, base: BaselineStats): Part | undefined {
  const x = f.rmssd;
  if (!x) return undefined;
  const b = base.baselines.rmssdMs;
  if (isNum(b) && b > 0 && base.counts.rmssd >= 3) {
    const z = (Math.log(x.value) - Math.log(b)) / Math.max(0.08, base.lnRmssdSd ?? 0.12);
    const phrase = z >= 0.5 ? 'HRV above your usual' : z <= -1 ? 'HRV well below your usual' : z < -0.5 ? 'HRV a bit below your usual' : 'HRV normal for you';
    return { score: zToScore(z), confidence: relConf(base.counts.rmssd), relative: true, phrase, inputs: x.inputsUsed };
  }
  // No personal baseline yet: rough population range (ln-scaled 15 → 90 ms).
  const score = clamp((Math.log(x.value) - Math.log(15)) / (Math.log(90) - Math.log(15))) * 100;
  return { score, confidence: 'low', relative: false, phrase: `HRV ${Math.round(x.value)} ms (still learning your baseline)`, inputs: x.inputsUsed };
}

export function rhrPart(f: NightFeatures, base: BaselineStats): Part | undefined {
  const x = f.rhr;
  if (!x) return undefined;
  const b = base.baselines.restingHrBpm;
  if (isNum(b) && base.counts.rhr >= 3) {
    const z = (b - x.value) / Math.max(1.5, base.rhrSd ?? 3);
    const d = Math.round(x.value - b);
    const phrase = d >= 3 ? `resting HR ${d} bpm above your usual` : d <= -2 ? 'resting HR below your usual' : 'resting HR normal';
    return { score: zToScore(z), confidence: relConf(base.counts.rhr), relative: true, phrase, inputs: x.inputsUsed };
  }
  return { score: linScore(x.value, 80, 45), confidence: 'low', relative: false, phrase: `resting HR ${Math.round(x.value)} bpm (still learning your baseline)`, inputs: x.inputsUsed };
}

/** 0 … 25 points off when skin temperature runs ≥ +0.3 °C above baseline. */
export function tempPenalty(f: NightFeatures): number {
  const d = f.skinTempDeltaC;
  return isNum(d) ? clamp((d - 0.3) / 0.9) * 25 : 0;
}

function recommendation(score: number, f: NightFeatures): { code: number; text: string } {
  const d = f.skinTempDeltaC;
  if ((isNum(d) && d >= 1) || score < 34) return { code: 0, text: 'rest' };
  return score >= 67 ? { code: 2, text: 'train hard' } : { code: 1, text: 'train light' };
}

const minConf = (...cs: Confidence[]): Confidence =>
  cs.includes('low') ? 'low' : cs.includes('medium') ? 'medium' : 'high';
const cap = (c: Confidence, max: Confidence): Confidence => minConf(c, max);

interface Variant {
  method: string;
  parts: Record<string, [Part | undefined, number]>;
  required: string[];
  maxConf: Confidence;
}

function build(ctx: Ctx, sleep: { value: number; inputs: string[] } | undefined): MetricResult[] {
  const { f, base } = ctx;
  const hrv = hrvPart(f, base);
  const rhr = rhrPart(f, base);
  const sleepPart: Part | undefined = sleep
    ? { score: sleep.value, confidence: 'medium', relative: true, phrase: sleep.value >= 70 ? 'sleep was solid' : sleep.value >= 50 ? 'sleep was okay' : 'sleep was short or broken', inputs: sleep.inputs }
    : undefined;
  const variants: Variant[] = [
    { method: 'hrv-rhr-v1', parts: { hrv: [hrv, 0.5], rhr: [rhr, 0.3], sleep: [sleepPart, 0.2] }, required: ['hrv', 'rhr'], maxConf: 'high' },
    { method: 'rhr-v1', parts: { rhr: [rhr, 0.7], sleep: [sleepPart, 0.3] }, required: ['rhr'], maxConf: 'medium' },
    { method: 'hrv-v1', parts: { hrv: [hrv, 0.7], sleep: [sleepPart, 0.3] }, required: ['hrv'], maxConf: 'medium' },
    { method: 'sleep-only-v1', parts: { sleep: [sleepPart, 1] }, required: ['sleep'], maxConf: 'low' },
  ];
  const pen = tempPenalty(f);
  const out: MetricResult[] = [];
  for (const v of variants) {
    if (v.required.some((k) => !v.parts[k]![0])) continue;
    const present = Object.entries(v.parts).filter(([, [p]]) => p) as [string, [Part, number]][];
    const c = combine(Object.fromEntries(present.map(([k, [p, w]]) => [k, [p.score, w]])));
    const score = clamp(c.value - pen, 0, 100);
    const physio = present.filter(([k]) => k !== 'sleep').map(([, [p]]) => p.confidence);
    const confidence = cap(physio.length ? minConf(...physio) : 'low', v.maxConf);
    const rec = recommendation(score, f);
    const why = present.map(([, [p]]) => p.phrase);
    if (pen >= 3) why.push(`skin temperature +${f.skinTempDeltaC!.toFixed(1)} °C (possible illness signal)`);
    const inputs = present.flatMap(([, [p]]) => p.inputs).concat(pen > 0 ? ['skinTempDeltaC'] : []);
    out.push(
      mk('recovery', v.method, score, confidence, inputs,
        `Recovery ${Math.round(score)}/100 — ${why.join(', ')}. Recommendation: ${rec.text}.`,
        { components: { ...c.components, tempPenalty: pen, recommendation: rec.code } }),
    );
  }
  return out;
}

export function recovery(ctx: Ctx, sleepScoreBest?: MetricResult): MetricResult[] {
  const sleep =
    sleepScoreBest && isNum(sleepScoreBest.value)
      ? { value: sleepScoreBest.value, inputs: sleepScoreBest.inputsUsed }
      : undefined;
  return build(ctx, sleep);
}

/** Best recovery value for an arbitrary night given the nights before it (used by moodLink). */
export function quickRecovery(f: NightFeatures, prior: NightFeatures[], needMin: number, baselineNights?: number): number | undefined {
  const base = baselineStats(prior, { nights: baselineNights });
  const s = bestSleepScore(f, needMin);
  const res = build({ f, hist: prior, base, needMin, opts: {} }, s ? { value: s.value, inputs: s.inputsUsed } : undefined);
  return pickBest(res)?.value ?? undefined;
}
