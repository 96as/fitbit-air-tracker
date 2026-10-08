import { describe, expect, it } from 'vitest';
import { compactNight } from './compact.js';
import { mockHistory, mockNightData, type MockDataTier } from './mock/night.js';
import { computeNightMetrics } from '../metrics/index.js';
import type { NightData } from '../health/types.js';

const TZ = 'Asia/Riyadh';
/** Max |compacted − full| per metric (minutes for durations/debt, points otherwise). */
const TOLERANCE: Record<string, number> = { sleepDuration: 5, sleepScore: 8, recovery: 5, sleepDebt: 20, consistency: 2, breathing: 0.1, skinTemp: 0.01 };

function compare(full: NightData[], compacted: NightData[], from: number) {
  for (let i = from; i < full.length; i++) {
    const a = computeNightMetrics(full[i]!, full.slice(0, i)).best;
    const b = computeNightMetrics(compacted[i]!, compacted.slice(0, i)).best;
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const k of Object.keys(a)) {
      expect(b[k]!.method, `${k} method`).toBe(a[k]!.method);
      if (a[k]!.value == null) continue;
      expect(Math.abs(b[k]!.value! - a[k]!.value!), `${full[i]!.dateLocal} ${k}`).toBeLessThanOrEqual(TOLERANCE[k] ?? 0);
    }
  }
}

describe('compactNight', () => {
  it('downsamples per-minute series, keeps sessions/summaries, is idempotent', () => {
    const n = mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 5 });
    const c = compactNight(n);
    expect(c.session).toEqual(n.session);
    expect(c.stillPeriods).toEqual(n.stillPeriods);
    expect(c.dailyHrv).toEqual(n.dailyHrv);
    expect(c.hrv).toBeUndefined(); // dailyHrv present
    expect(c.heartRateMotion).toBeUndefined();
    expect(c.spo2!.length).toBeLessThanOrEqual(Math.ceil(n.spo2!.length / 5) + 1);
    expect(c.heartRate!.length).toBeLessThan(n.heartRate!.length / 3);
    const steps = (xs: NightData['steps']) => xs!.reduce((s, x) => s + x.value, 0);
    expect(steps(c.steps)).toBe(steps(n.steps)); // sums preserved
    expect(compactNight(c)).toEqual(c);
    // No daily summary → raw HRV is kept as 30-min means.
    const noDaily = compactNight({ ...n, dailyHrv: undefined });
    expect(noDaily.hrv!.length).toBeGreaterThan(5);
    expect(noDaily.hrv!.length).toBeLessThan(25);
  });

  for (const tier of ['full', 'no-stages', 'hr-only', 'motion-only'] as MockDataTier[]) {
    it(`metrics on compacted nights stay within tolerance (${tier})`, () => {
      const full = mockHistory(20, { endDateLocal: '2026-10-08', tz: TZ, seed: 5, tier });
      // Everything compacted (worst case)…
      compare(full, full.map((n) => compactNight(n)), 10);
      // …and the real layout: newest night full, history compacted.
      compare(full, full.map((n, i) => (i === full.length - 1 ? n : compactNight(n))), 19);
    });
  }

  it('60 stored nights (3 newest full) fit well under 1.5 MB', () => {
    const nights = mockHistory(60, { endDateLocal: '2026-10-08', tz: TZ, seed: 5 });
    const fullKb = JSON.stringify(nights).length / 1024;
    const storedKb = JSON.stringify(nights.map((n, i) => (i >= 57 ? n : compactNight(n)))).length / 1024;
    console.log(`healthStore estimate: ${storedKb.toFixed(0)} KB for 60 nights (uncompacted ${fullKb.toFixed(0)} KB)`);
    expect(storedKb).toBeLessThan(1.2 * 1024);
  });
});
