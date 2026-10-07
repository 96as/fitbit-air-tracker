/**
 * moodLink — does your mood track your sleep? Pearson correlation of the
 * night's mood check-in score with sleepDuration / recovery / sleepScore.
 * Needs ≥ 7 nights with mood; low confidence below 14. Correlation only —
 * explanations say so.
 */
import type { MetricResult } from '../health/types.js';
import { mk, type Ctx } from './context.js';
import { bestSleepScore } from './features.js';
import { quickRecovery } from './recovery.js';
import { isNum, pearson } from './util.js';

export const MOOD_MIN_NIGHTS = 7;

const LABEL: Record<string, string> = {
  sleepDuration: 'longer sleep',
  recovery: 'higher recovery',
  sleepScore: 'a better sleep score',
};

export function moodLink(ctx: Ctx): MetricResult[] {
  const nights = [...ctx.hist, ctx.f];
  const withMood = nights.map((f, i) => ({ f, i })).filter((x) => isNum(x.f.mood));
  if (withMood.length === 0) return [];
  if (withMood.length < MOOD_MIN_NIGHTS) {
    return [mk('moodLink', 'pearson-v1', null, 'low', ['mood'],
      `Log your mood on ${MOOD_MIN_NIGHTS - withMood.length} more mornings to see how it links to your sleep.`,
      { components: { n: withMood.length } })];
  }
  const series: Record<string, [number[], number[]]> = { sleepDuration: [[], []], recovery: [[], []], sleepScore: [[], []] };
  const inputs = new Set<string>(['mood']);
  for (const { f, i } of withMood) {
    const push = (k: string, v: number | undefined) => {
      if (isNum(v)) {
        series[k]![0].push(f.mood!);
        series[k]![1].push(v);
      }
    };
    push('sleepDuration', f.asleep?.value);
    push('sleepScore', bestSleepScore(f, ctx.needMin)?.value);
    push('recovery', quickRecovery(f, nights.slice(0, i), ctx.needMin, ctx.opts.baselineNights));
    f.asleep?.inputsUsed.forEach((x) => inputs.add(x));
  }
  const comps: Record<string, number | undefined> = {};
  let best: { k: string; r: number; n: number } | undefined;
  for (const [k, [m, v]] of Object.entries(series)) {
    if (m.length < MOOD_MIN_NIGHTS) continue;
    const r = pearson(m, v);
    comps[`r_${k}`] = r;
    comps[`n_${k}`] = m.length;
    if (isNum(r) && (!best || Math.abs(r) > Math.abs(best.r))) best = { k, r, n: m.length };
  }
  if (!best) {
    return [mk('moodLink', 'pearson-v1', null, 'low', [...inputs],
      'Not enough variation in your mood or sleep yet to see a link.', { components: { ...comps, n: withMood.length } })];
  }
  const a = Math.abs(best.r);
  const strength = a < 0.2 ? 'no clear' : a < 0.4 ? 'a weak' : a < 0.6 ? 'a moderate' : 'a strong';
  const dir = best.r >= 0 ? 'better' : 'worse';
  const expl =
    a < 0.2
      ? `So far there's no clear link between your mood and your sleep (${best.n} nights).`
      : `There's ${strength} pattern: your mood tends to be ${dir} after ${LABEL[best.k]} (r = ${best.r.toFixed(2)}, ${best.n} nights) — a pattern, not proof of cause.`;
  return [mk('moodLink', 'pearson-v1', best.r, best.n >= 14 ? 'medium' : 'low', [...inputs], expl, {
    decimals: 2,
    components: { ...comps, strongest: ['sleepDuration', 'recovery', 'sleepScore'].indexOf(best.k), n: best.n },
  })];
}
