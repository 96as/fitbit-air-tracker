import { describe, expect, it } from 'vitest';
import type { SleepStage, SleepStageSegment } from '../types.js';
import { actigraphyWake, estimateStages, summarizeStages } from './staging.js';
import { TIERS, makeNight } from './__fixtures__/nights.js';

const DATE = '2026-10-08';

function stageAt(segs: SleepStageSegment[], t: number): SleepStage | undefined {
  return segs.find((s) => t >= Date.parse(s.startUtc) && t < Date.parse(s.endUtc))?.stage;
}

/** Share of truth minutes where sleep/wake matches. */
function sleepWakeAgreement(segs: SleepStageSegment[], truth: { startMs: number; stages: SleepStage[] }) {
  let ok = 0;
  truth.stages.forEach((s, i) => {
    const est = stageAt(segs, truth.startMs + i * 60_000 + 30_000) ?? 'awake';
    if ((s === 'awake') === (est === 'awake')) ok++;
  });
  return ok / truth.stages.length;
}

describe('estimateStages', () => {
  for (const [tier, method] of [
    ['hrSteps', 'hr-motion-v1'],
    ['hrOnly', 'hr-only-v1'],
    ['motionOnly', 'motion-only-v1'],
  ] as const) {
    it(`${tier} → ${method}, tracks true sleep/wake`, () => {
      const { night, truth } = makeNight({ dateLocal: DATE, seed: 11, fields: TIERS[tier] });
      const est = estimateStages(night)!;
      expect(est.method).toBe(method);
      expect(est.confidence).toBe(method === 'hr-motion-v1' ? 'medium' : 'low');
      expect(sleepWakeAgreement(est.segments, truth)).toBeGreaterThan(0.85);
      const sum = summarizeStages(est.segments)!;
      const trueAsleep = truth.stages.filter((s) => s !== 'awake').length;
      expect(Math.abs(sum.asleepMin - trueAsleep)).toBeLessThan(60);
      if (method === 'motion-only-v1') {
        expect(new Set(est.segments.map((s) => s.stage))).toEqual(new Set(['awake', 'light']));
      } else {
        expect(sum.deepMin).toBeGreaterThan(0);
        expect(sum.remMin).toBeGreaterThan(0);
      }
      // segments are contiguous and ordered
      for (let i = 1; i < est.segments.length; i++) expect(est.segments[i]!.startUtc).toBe(est.segments[i - 1]!.endUtc);
    });
  }

  it('HR staging puts deep sleep mostly where the truth has deep sleep', () => {
    const { night, truth } = makeNight({ dateLocal: DATE, seed: 5, fields: ['hr', 'steps', 'still'] });
    const est = estimateStages(night)!;
    let deepHit = 0;
    let deepEst = 0;
    truth.stages.forEach((s, i) => {
      if (stageAt(est.segments, truth.startMs + i * 60_000 + 30_000) === 'deep') {
        deepEst++;
        if (s === 'deep') deepHit++;
      }
    });
    expect(deepEst).toBeGreaterThan(0);
    expect(deepHit / deepEst).toBeGreaterThan(0.6);
  });

  it('uses the session window when a session exists', () => {
    const { night } = makeNight({ dateLocal: DATE, seed: 3, fields: ['stages', 'hr'] });
    const est = estimateStages(night)!;
    expect(est.segments[0]!.startUtc).toBe(night.session!.startUtc);
  });

  it('returns null without usable data', () => {
    expect(estimateStages({ dateLocal: DATE, tz: 'UTC' })).toBeNull();
    // 20 minutes of HR is not a night
    const hr = Array.from({ length: 20 }, (_, i) => ({ tsUtc: new Date(Date.UTC(2026, 9, 8, 1, i)).toISOString(), value: 55 }));
    expect(estimateStages({ dateLocal: DATE, tz: 'UTC', heartRate: hr })).toBeNull();
  });

  it('is deterministic', () => {
    const { night } = makeNight({ dateLocal: DATE, seed: 9, fields: TIERS.hrSteps });
    expect(JSON.stringify(estimateStages(night))).toBe(JSON.stringify(estimateStages(structuredClone(night))));
  });
});

describe('actigraphyWake (Cole–Kripke + Webster)', () => {
  it('scores stillness as sleep and sustained activity as wake', () => {
    const a = [...Array(30).fill(0), ...Array(10).fill(200), ...Array(30).fill(0)];
    const w = actigraphyWake(a);
    expect(w.slice(0, 20).every((x) => !x)).toBe(true);
    expect(w.slice(32, 40).every((x) => x)).toBe(true);
    expect(w.slice(55).every((x) => !x)).toBe(true);
  });

  it('a single small twitch does not wake', () => {
    const a = Array(30).fill(0);
    a[15] = 40;
    expect(actigraphyWake(a).some((x) => x)).toBe(false);
  });
});
