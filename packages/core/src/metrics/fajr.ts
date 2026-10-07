/**
 * fajrWakeEase — how easy waking for Fajr was likely to be, from how deep the
 * sleep was in the window [Fajr − 30 min, Fajr + 15 min] (our smart-wake
 * window). Basis: waking from deep (N3) sleep gives the worst sleep inertia,
 * waking from light (N1/N2) the least (Tassi & Muzet 2000).
 */
import type { SleepStage, SleepStageSegment } from '../types.js';
import type { MetricResult } from '../health/types.js';
import { mk, type Ctx } from './context.js';
import { downgrade, isNum, ms } from './util.js';

const BEFORE_MIN = 30;
const AFTER_MIN = 15;
const EASE: Record<SleepStage, number> = { awake: 100, light: 85, rem: 55, deep: 10 };

function stageMinutes(segments: SleepStageSegment[], fajrMs: number) {
  const segs = segments.map((s) => ({ stage: s.stage, a: ms(s.startUtc), b: ms(s.endUtc) })).filter((s) => s.b > s.a);
  const sleep = segs.filter((s) => s.stage !== 'awake');
  if (sleep.length === 0) return undefined;
  const onset = Math.min(...sleep.map((s) => s.a));
  const finalWake = Math.max(...sleep.map((s) => s.b));
  const counts: Record<SleepStage, number> = { awake: 0, light: 0, rem: 0, deep: 0 };
  let known = 0;
  for (let k = -BEFORE_MIN; k < AFTER_MIN; k++) {
    const t = fajrMs + k * 60_000 + 30_000;
    const seg = segs.find((s) => t >= s.a && t < s.b);
    const st: SleepStage | undefined = seg ? seg.stage : t >= finalWake || t < onset ? 'awake' : undefined;
    if (!st) continue;
    counts[st]++;
    known++;
  }
  return { counts, known };
}

export function fajrWakeEase(ctx: Ctx): MetricResult[] {
  const { f, opts } = ctx;
  if (!opts.fajrUtc || !isNum(ms(opts.fajrUtc))) return [];
  const fajr = ms(opts.fajrUtc);
  if (opts.nowUtc && isNum(ms(opts.nowUtc)) && ms(opts.nowUtc) < fajr + AFTER_MIN * 60_000) return [];
  const total = BEFORE_MIN + AFTER_MIN;
  const out: MetricResult[] = [];
  const add = (method: string, segs: SleepStageSegment[], confidence: MetricResult['confidence'], inputs: string[], detailed: boolean) => {
    const m = stageMinutes(segs, fajr);
    if (!m || m.known < total / 2) return;
    const c = m.counts;
    const ease = (c.awake * EASE.awake + c.light * EASE.light + c.rem * EASE.rem + c.deep * EASE.deep) / m.known;
    const dominant = (Object.keys(c) as SleepStage[]).reduce((a, b) => (c[b] > c[a] ? b : a));
    const where =
      c.awake >= m.known * 0.6 ? 'you were already mostly awake'
        : dominant === 'deep' ? 'you were mostly in deep sleep — the hardest stage to wake from'
          : dominant === 'rem' ? 'you were mostly in REM (dreaming) sleep — moderately easy to wake from'
            : 'you were mostly in light sleep — the easiest time to wake';
    out.push(mk('fajrWakeEase', method, ease, confidence, inputs,
      `Around Fajr ${where} (ease ${Math.round(ease)}/100${detailed ? '' : ', light vs deep not measurable from movement alone'}).`,
      { components: { deepMin: c.deep, remMin: c.rem, lightMin: c.light, awakeMin: c.awake, coveredMin: m.known } }));
  };
  if (f.google) add('stages-v1', f.night.session!.stages, f.inProgress ? 'medium' : 'high', ['session'], true);
  const own = f.own;
  if (own) {
    const detailed = own.method !== 'motion-only-v1';
    add('own-staging-v1', own.segments, detailed ? own.confidence : downgrade(own.confidence), own.inputsUsed, detailed);
  }
  return out;
}
