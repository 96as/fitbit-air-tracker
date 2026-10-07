/** sleepDuration, sleepScore, sleepDebt, consistency. */
import type { MetricResult } from '../health/types.js';
import { wallTimeToUtc } from '../util/tz.js';
import { mk, type Ctx } from './context.js';
import { durationScore, scoreFromSummary, type NightFeatures } from './features.js';
import type { StageSummary } from './staging.js';
import {
  MIN_MS,
  bedtimeMinutes,
  clamp,
  dayNumber,
  downgrade,
  fmtClock,
  fmtDuration,
  isNum,
  linScore,
  localMinuteOfDay,
  median,
  ms,
  sd,
} from './util.js';

const inProgressNote = (f: NightFeatures) => (f.inProgress ? ' so far (night still being processed)' : '');
const conf = (f: NightFeatures, c: MetricResult['confidence']) => (f.inProgress ? downgrade(c) : c);

function vsUsual(ctx: Ctx, asleep: number): string {
  const b = ctx.base.baselines.sleepMinutes;
  if (!isNum(b) || ctx.base.counts.sleep < 3) return '';
  const d = Math.round(asleep - b);
  if (Math.abs(d) < 15) return ', about your usual';
  return d > 0 ? `, ${fmtDuration(d)} more than your usual` : `, ${fmtDuration(-d)} less than your usual`;
}

// ------------------------------------------------------------ sleepDuration --

export function sleepDuration(ctx: Ctx): MetricResult[] {
  const { f } = ctx;
  const out: MetricResult[] = [];
  const M = 'sleepDuration';
  if (f.google) {
    const g = f.google;
    out.push(
      mk(M, 'stages-v1', g.asleepMin, conf(f, 'high'), ['session'],
        `You slept ${fmtDuration(g.asleepMin)}${inProgressNote(f)}${vsUsual(ctx, g.asleepMin)} (from Google's sleep stages).`,
        { unit: 'min', components: { deepMin: g.deepMin, remMin: g.remMin, lightMin: g.lightMin, wasoMin: g.wasoMin } }),
    );
  }
  if (f.night.session && isNum(f.inBedMin) && f.inBedMin > 0) {
    const eff = isNum(f.sessionAsleepMin);
    const v = eff ? f.sessionAsleepMin! : f.inBedMin;
    out.push(
      mk(M, 'session-bounds-v1', v, conf(f, eff ? 'medium' : 'low'), ['session'],
        eff
          ? `About ${fmtDuration(v)} asleep${inProgressNote(f)}${vsUsual(ctx, v)}, from your sleep window and its ${f.night.session.efficiencyPct}% efficiency.`
          : `About ${fmtDuration(v)} from falling asleep to waking${inProgressNote(f)} — time awake in between isn't known, so this may overcount.`,
        { unit: 'min', components: { inBedMin: f.inBedMin, efficiencyPct: f.night.session.efficiencyPct } }),
    );
  }
  const os = f.ownSummary;
  if (os) {
    out.push(
      mk(M, 'own-staging-v1', os.asleepMin, conf(f, f.own!.confidence), f.own!.inputsUsed,
        `About ${fmtDuration(os.asleepMin)} asleep${vsUsual(ctx, os.asleepMin)}, estimated from your ${ownInputsPhrase(f)} (${f.own!.method}).`,
        { unit: 'min', components: { wasoMin: os.wasoMin, deepMin: os.detailed ? os.deepMin : undefined, remMin: os.detailed ? os.remMin : undefined } }),
    );
  }
  return out;
}

export function ownInputsPhrase(f: NightFeatures): string {
  const m = f.own?.method;
  return m === 'hr-motion-v1' ? 'heart rate and movement' : m === 'hr-only-v1' ? 'heart rate' : 'movement';
}

// --------------------------------------------------------------- sleepScore --

function describeScore(score: number, s: StageSummary): string {
  const parts = [`${fmtDuration(s.asleepMin)} asleep`];
  if (s.detailed && s.asleepMin > 0) {
    parts.push(`${Math.round((s.deepMin / s.asleepMin) * 100)}% deep`, `${Math.round((s.remMin / s.asleepMin) * 100)}% REM`);
  }
  parts.push(`${Math.round(s.wasoMin)} min awake in the night`);
  const word = score >= 80 ? 'Great night' : score >= 60 ? 'Decent night' : score >= 40 ? 'Below-par night' : 'Rough night';
  return `${word}: ${parts.join(', ')}`;
}

export function sleepScore(ctx: Ctx): MetricResult[] {
  const { f, needMin } = ctx;
  const M = 'sleepScore';
  const out: MetricResult[] = [];
  if (f.google) {
    const s = scoreFromSummary(f.google, needMin);
    out.push(mk(M, 'stages-v1', s.value, conf(f, 'high'), ['session'],
      `${describeScore(s.value, f.google)}${inProgressNote(f)}.`, { components: s.components }));
  }
  const os = f.ownSummary;
  if (os) {
    const s = scoreFromSummary(os, needMin);
    out.push(mk(M, 'own-staging-v1', s.value, conf(f, f.own!.method === 'hr-motion-v1' ? 'medium' : 'low'), f.own!.inputsUsed,
      `${describeScore(s.value, os)} — estimated from your ${ownInputsPhrase(f)}${os.detailed ? '' : ' (deep/REM not measurable without heart rate)'}.`,
      { components: s.components }));
  }
  const a = f.asleep;
  if (a) {
    const v = durationScore(a.value, needMin);
    out.push(mk(M, 'duration-only-v1', v, 'low', a.inputsUsed,
      `Based only on sleeping ${fmtDuration(a.value)} against your ${fmtDuration(needMin)} need — no sleep-quality data.`,
      { components: { duration: v } }));
  }
  return out;
}

// ---------------------------------------------------------------- sleepDebt --

/** Nights (history + current) whose date falls within `days` days ending on the current night. */
export function recentNights(ctx: Ctx, days: number): NightFeatures[] {
  const d0 = dayNumber(ctx.f.night.dateLocal);
  const seen = new Set<string>([ctx.f.night.dateLocal]);
  const prev: NightFeatures[] = [];
  for (let i = ctx.hist.length - 1; i >= 0; i--) {
    const h = ctx.hist[i]!;
    const dd = d0 - dayNumber(h.night.dateLocal);
    if (dd >= 1 && dd < days && !seen.has(h.night.dateLocal)) {
      seen.add(h.night.dateLocal);
      prev.unshift(h);
    }
  }
  return [...prev, ctx.f];
}

export function sleepDebt(ctx: Ctx): MetricResult[] {
  const nights = recentNights(ctx, 7).filter((n) => n.asleep);
  if (nights.length === 0) return [];
  const need = ctx.needMin;
  const slept = nights.map((n) => n.asleep!.value);
  const net = slept.reduce((a, s) => a + (need - s), 0);
  const debt = Math.max(0, net);
  const highShare = nights.filter((n) => n.asleep!.confidence === 'high').length / nights.length;
  const c = nights.length >= 7 && highShare >= 0.7 ? 'high' : nights.length >= 5 ? 'medium' : 'low';
  const avg = slept.reduce((a, b) => a + b, 0) / slept.length;
  const span = nights.length === 1 ? 'last night (no earlier nights yet)' : `the last ${nights.length} nights`;
  const expl =
    debt < 30
      ? `No real sleep debt — you averaged ${fmtDuration(avg)} a night over ${span} against a ${fmtDuration(need)} need.`
      : `You're ${fmtDuration(debt)} short of sleep across ${span} (average ${fmtDuration(avg)} a night vs ${fmtDuration(need)} need) — an earlier night or a nap after Dhuhr helps pay it back.`;
  return [
    mk('sleepDebt', 'rolling-7-v1', debt, c, [...new Set(nights.flatMap((n) => n.asleep!.inputsUsed))], expl, {
      unit: 'min',
      components: { nights: nights.length, avgSleepMin: avg, needMin: need, surplusMin: Math.max(0, -net) },
    }),
  ];
}

// -------------------------------------------------------------- consistency --

export function consistency(ctx: Ctx): MetricResult[] {
  const M = 'consistency';
  const out: MetricResult[] = [];
  const nights = recentNights(ctx, 14);
  const timed = nights.filter((n) => n.timing);
  if (timed.length >= 3) {
    const bed = timed.map((n) => bedtimeMinutes(n.timing!.value.bedUtc, n.night.tz));
    const wake = timed.map((n) => localMinuteOfDay(n.timing!.value.wakeUtc, n.night.tz));
    const sdBed = sd(bed)!;
    const sdWake = sd(wake)!;
    const avgSd = (sdBed + sdWake) / 2;
    const score = linScore(avgSd, 120, 15);
    const c = timed.length >= 12 ? 'high' : timed.length >= 7 ? 'medium' : 'low';
    const steady = score >= 75 ? 'Very steady' : score >= 50 ? 'Fairly steady' : 'Irregular';
    out.push(mk(M, 'timing-sd-v1', score, c, [...new Set(timed.flatMap((n) => n.timing!.inputsUsed))],
      `${steady} schedule: bedtime varies about ±${Math.round(sdBed)} min around ${fmtClock(median(bed)!)} and wake time ±${Math.round(sdWake)} min around ${fmtClock(median(wake)!)} over ${timed.length} nights.`,
      { components: { bedtimeSdMin: sdBed, waketimeSdMin: sdWake, nights: timed.length, medianBedtimeMin: median(bed), medianWaketimeMin: median(wake) } }));
  }
  const sri = sleepRegularityIndex(nights);
  if (sri) {
    const v = clamp(sri.sri, 0, 100);
    out.push(mk(M, 'sri-v1', v, sri.pairs >= 7 ? 'medium' : 'low', sri.inputs,
      `Sleep Regularity Index ${Math.round(sri.sri)}: you were in the same state (asleep/awake) at the same clock time on consecutive days ${Math.round(sri.agree * 100)}% of the time (${sri.pairs} day pairs).`,
      { components: { sri: sri.sri, dayPairs: sri.pairs } }));
  }
  return out;
}

/** Sleep intervals (ms) for a night: Google stages → session span → own staging. */
function sleepIntervals(n: NightFeatures): { iv: [number, number][]; inputs: string[] } | undefined {
  const toIv = (segs: { stage: string; startUtc: string; endUtc: string }[]) =>
    segs.filter((s) => s.stage !== 'awake').map((s) => [ms(s.startUtc), ms(s.endUtc)] as [number, number]);
  if (n.google) return { iv: toIv(n.night.session!.stages), inputs: ['session'] };
  if (n.night.session) return { iv: [[ms(n.night.session.startUtc), ms(n.night.session.endUtc)]], inputs: ['session'] };
  if (n.own) return { iv: toIv(n.own.segments), inputs: n.own.inputsUsed };
  return undefined;
}

function prevDate(dateLocal: string): string {
  const t = (dayNumber(dateLocal) - 1) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Sleep Regularity Index (Phillips et al. 2017), restricted to the night
 * window 18:00 → 14:00 local: 200 × P(same sleep/wake state 24 h apart) − 100.
 */
function sleepRegularityIndex(nights: NightFeatures[]) {
  const WIN = 20 * 60;
  const states = new Map<number, Uint8Array>();
  const inputs = new Set<string>();
  for (const n of nights) {
    const s = sleepIntervals(n);
    if (!s) continue;
    const start = wallTimeToUtc(prevDate(n.night.dateLocal), '18:00', n.night.tz).getTime();
    const arr = new Uint8Array(WIN);
    for (const [a, b] of s.iv) {
      const i0 = Math.max(0, Math.floor((a - start) / MIN_MS));
      const i1 = Math.min(WIN, Math.ceil((b - start) / MIN_MS));
      for (let i = i0; i < i1; i++) arr[i] = 1;
    }
    states.set(dayNumber(n.night.dateLocal), arr);
    s.inputs.forEach((x) => inputs.add(x));
  }
  let agree = 0;
  let total = 0;
  let pairs = 0;
  for (const [d, arr] of states) {
    const next = states.get(d + 1);
    if (!next) continue;
    pairs++;
    for (let i = 0; i < WIN; i++) {
      total++;
      if (arr[i] === next[i]) agree++;
    }
  }
  if (pairs < 3 || total === 0) return undefined;
  const p = agree / total;
  return { sri: 200 * p - 100, agree: p, pairs, inputs: [...inputs] };
}
