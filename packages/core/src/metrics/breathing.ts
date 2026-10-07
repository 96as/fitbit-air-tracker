/**
 * breathing (respiratory rate, SpO2) and skinTemp. Wellness signals only —
 * never diagnoses. Flags use "unusual for you" language plus a gentle nudge.
 */
import type { MetricResult } from '../health/types.js';
import { mk, type Ctx } from './context.js';
import { recentNights } from './sleep.js';
import { isNum, mean, median, ms } from './util.js';

const NUDGE = 'this is a wellness signal, not a diagnosis — if it repeats, consider talking to a doctor';

export function breathing(ctx: Ctx): MetricResult[] {
  const { f, base } = ctx;
  const out: MetricResult[] = [];

  // respiratory-v1: nightly breathing rate vs personal baseline.
  const r = f.respBrpm;
  if (r) {
    const b = base.baselines.respiratoryBrpm;
    const hasBase = isNum(b) && base.counts.resp >= 3;
    const delta = hasBase ? r.value - b! : undefined;
    const unusual = hasBase ? Math.abs(delta!) >= Math.max(2, 3 * (base.respSd ?? 0)) : r.value < 10 || r.value > 22;
    const c = base.counts.resp >= 14 ? 'high' : base.counts.resp >= 7 ? 'medium' : 'low';
    const rate = `${r.value.toFixed(1)} breaths/min`;
    const expl = unusual
      ? `Breathing rate ${rate} is unusual for you${hasBase ? ` (usual ${b!.toFixed(1)})` : ''} — ${NUDGE}.`
      : hasBase
        ? `Breathing rate ${rate} during sleep, in line with your usual ${b!.toFixed(1)}.`
        : `Breathing rate ${rate} during sleep, within the typical adult range (still learning your baseline).`;
    out.push(mk('breathing', 'respiratory-v1', r.value, c, r.inputsUsed, expl, {
      unit: 'brpm', decimals: 1,
      components: { brpm: r.value, baselineBrpm: hasBase ? b : undefined, deltaBrpm: delta, unusual: unusual ? 1 : 0 },
    }));
  }

  // spo2-v1: average oxygen saturation + time below 90 % when samples exist.
  const avg = f.spo2Avg;
  if (avg) {
    const samples = (f.night.spo2 ?? []).filter((s) => isNum(s.value) && s.value > 50 && s.value <= 100 && isNum(ms(s.tsUtc)));
    let below90: number | undefined;
    let minPct: number | undefined;
    if (samples.length >= 10) {
      const ts = samples.map((s) => ms(s.tsUtc)).sort((a, b) => a - b);
      const gaps = ts.slice(1).map((t, i) => (t - ts[i]!) / 60_000).filter((g) => g > 0);
      const step = Math.min(5, Math.max(1 / 60, median(gaps) ?? 1));
      below90 = samples.filter((s) => s.value < 90).length * step;
      minPct = Math.min(...samples.map((s) => s.value));
    }
    const b = base.baselines.spo2AvgPct;
    const hasBase = isNum(b) && base.counts.spo2 >= 3;
    const unusual = avg.value < 92 || (isNum(below90) && below90 >= 10) || (hasBase && avg.value <= b! - 2);
    const inputs = [...avg.inputsUsed, ...(isNum(below90) ? ['spo2'] : [])];
    const time = isNum(below90) ? `, ${Math.round(below90)} min below 90%` : '';
    const expl = unusual
      ? `Blood oxygen averaged ${avg.value.toFixed(1)}%${time} — unusual for you; wrist readings can be off, but ${NUDGE}.`
      : `Blood oxygen averaged ${avg.value.toFixed(1)}%${time} — a normal range for sleep.`;
    out.push(mk('breathing', 'spo2-v1', avg.value, isNum(below90) ? 'medium' : 'low', inputs, expl, {
      unit: '%', decimals: 1,
      components: { avgPct: avg.value, minPct, minutesBelow90: below90, baselinePct: hasBase ? b : undefined, unusual: unusual ? 1 : 0 },
    }));
  }
  return out;
}

function interpretTemp(d: number): string {
  if (d >= 1) return 'notably warmer than your baseline — this often comes with illness, alcohol, a late heavy meal or a hot room; take it easy and watch how you feel';
  if (d >= 0.5) return 'warmer than your baseline — can come with a cold starting, alcohol, late meals, a warm room or the menstrual cycle';
  if (d <= -0.5) return 'cooler than your baseline — usually a cooler room or lighter covers';
  return 'within your normal range';
}

export function skinTemp(ctx: Ctx): MetricResult[] {
  const out: MetricResult[] = [];
  const d = ctx.f.skinTempDeltaC;
  const sign = (x: number) => (Math.abs(x) < 0.05 ? '±0.0 °C' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} °C`);
  if (isNum(d)) {
    out.push(mk('skinTemp', 'nightly-delta-v1', d, 'medium', ['skinTempDeltaC'],
      `Skin temperature ${sign(d)}: ${interpretTemp(d)}.`, { unit: '°C', decimals: 2, components: { deltaC: d } }));
  }
  const recent = recentNights(ctx, 3).map((n) => n.skinTempDeltaC).filter(isNum);
  if (recent.length >= 2) {
    const m = mean(recent)!;
    const sustained = recent.every((x) => x >= 0.5);
    out.push(mk('skinTemp', 'trend-3-v1', m, 'low', ['skinTempDeltaC'],
      sustained
        ? `Skin temperature has stayed raised (avg ${sign(m)}) for ${recent.length} nights — a sustained rise is worth noting; ${NUDGE}.`
        : `Over the last ${recent.length} nights skin temperature averaged ${sign(m)}: ${interpretTemp(m)}.`,
      { unit: '°C', decimals: 2, components: { avgDeltaC: m, nights: recent.length, sustained: sustained ? 1 : 0 } }));
  }
  return out;
}
