import { describe, expect, it } from 'vitest';
import type { MetricsReport, NightData } from '../health/types.js';
import { computeBaselines, computeNightMetrics, durationLabel, scoreLabel } from './index.js';
import { TIERS, addDaysLocal, makeHistory, makeNight } from './__fixtures__/nights.js';

const DATE = '2026-10-08';
const methods = (r: MetricsReport, id: string) => (r.all[id] ?? []).map((x) => x.method);

const SCORE_0_100 = ['sleepScore', 'recovery', 'consistency', 'fajrWakeEase'];

function checkInvariants(r: MetricsReport) {
  for (const [id, results] of Object.entries(r.all)) {
    expect(results.length).toBeGreaterThan(0);
    expect(r.best[id]).toBeDefined();
    expect(results).toContain(r.best[id]);
    for (const x of results) {
      expect(x.metric).toBe(id);
      if (x.value !== null) {
        expect(Number.isFinite(x.value)).toBe(true);
        if (SCORE_0_100.includes(id)) {
          expect(x.value).toBeGreaterThanOrEqual(0);
          expect(x.value).toBeLessThanOrEqual(100);
        }
        if (id === 'sleepDuration' || id === 'sleepDebt') expect(x.value).toBeGreaterThanOrEqual(0);
        if (id === 'moodLink') expect(Math.abs(x.value)).toBeLessThanOrEqual(1);
      }
      expect(x.explanation.trim().length).toBeGreaterThan(10);
      expect(x.explanation).not.toMatch(/\n|NaN|undefined|Infinity/);
      expect(['high', 'medium', 'low']).toContain(x.confidence);
      if (x.value !== null) {
        expect(typeof x.label).toBe('string');
        expect(x.label!.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
      } else {
        expect(x.label).toBeUndefined();
      }
      for (const v of Object.values(x.components ?? {})) expect(Number.isFinite(v)).toBe(true);
    }
  }
  for (const v of Object.values(r.baselines)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  // Best is the highest-confidence non-null result.
  const rank = { high: 3, medium: 2, low: 1 } as const;
  for (const [id, best] of Object.entries(r.best)) {
    const nonNull = r.all[id]!.filter((x) => x.value !== null);
    if (nonNull.length) {
      expect(best.value).not.toBeNull();
      for (const x of nonNull) expect(rank[best.confidence]).toBeGreaterThanOrEqual(rank[x.confidence]);
    }
  }
  if (r.all.recovery) {
    for (const x of r.all.recovery) {
      const m = x.explanation.match(/Recommendation: (train hard|train light|rest)\.$/);
      expect(m).not.toBeNull();
      expect(x.label!.toLowerCase()).toBe(m![1]);
    }
  }
}

function tierNight(tier: string, extra: Partial<Parameters<typeof makeNight>[0]> = {}): NightData {
  return makeNight({ dateLocal: DATE, seed: 7, fields: TIERS[tier], mood: 4, ...extra }).night;
}

describe('computeNightMetrics — data tiers', () => {
  const history30 = makeHistory(30, DATE);

  it('everything + 30-night history: all metrics, Google stages win', () => {
    const night = tierNight('everything');
    const fajrUtc = night.session!.stages.at(-1)!.endUtc; // around wake-up
    const r = computeNightMetrics(night, history30, { fajrUtc });
    checkInvariants(r);
    expect(methods(r, 'sleepDuration')).toEqual(['stages-v1', 'session-bounds-v1', 'own-staging-v1']);
    expect(r.best.sleepDuration!.method).toBe('stages-v1');
    expect(methods(r, 'sleepScore')).toEqual(['stages-v1', 'own-staging-v1', 'duration-only-v1']);
    expect(r.best.sleepScore!.method).toBe('stages-v1');
    expect(r.best.sleepScore!.components).toHaveProperty('deep');
    expect(methods(r, 'recovery')).toEqual(['hrv-rhr-v1', 'rhr-v1', 'hrv-v1', 'sleep-only-v1']);
    expect(r.best.recovery!.method).toBe('hrv-rhr-v1');
    expect(r.best.recovery!.confidence).toBe('high');
    expect(r.best.sleepDebt!.confidence).toBe('high');
    expect(methods(r, 'consistency')).toEqual(['timing-sd-v1', 'sri-v1']);
    expect(r.best.consistency!.confidence).toBe('high');
    expect(methods(r, 'breathing')).toEqual(['respiratory-v1', 'spo2-v1']);
    expect(methods(r, 'skinTemp')).toEqual(['nightly-delta-v1', 'trend-3-v1']);
    expect(r.best.moodLink!.value).not.toBeNull();
    expect(r.best.moodLink!.confidence).toBe('medium');
    expect(methods(r, 'fajrWakeEase')).toEqual(['stages-v1', 'own-staging-v1']);
    expect(r.baselines.nights).toBe(30);
    expect(r.baselines.counts).toEqual({
      restingHrBpm: 30, rmssdMs: 30, respiratoryBrpm: 30, spo2AvgPct: 30, sleepMinutes: 30, bedtimeMin: 30, waketimeMin: 30,
    });
    expect(r.best.sleepDuration!.label).toMatch(/^\d+h \d{2}m$/);
    expect(['Great', 'Good', 'Fair', 'Poor']).toContain(r.best.sleepScore!.label);
    expect(['Great', 'Good', 'Fair', 'Poor']).toContain(r.best.consistency!.label);
    expect(['On track', 'Slightly short', 'Sleep debt']).toContain(r.best.sleepDebt!.label);
    expect(r.best.breathing!.label).toBe('Normal for you');
    expect(r.best.skinTemp!.label).toBe('Normal');
    expect(['Sleep length', 'Recovery', 'Sleep score']).toContain(r.best.moodLink!.label);
    expect(['Easy', 'Moderate', 'Hard']).toContain(r.best.fajrWakeEase!.label);
    expect(r.baselines.restingHrBpm).toBeGreaterThan(50);
    expect(r.baselines.rmssdMs).toBeGreaterThan(30);
    expect(r.baselines.sleepMinutes).toBeGreaterThan(300);
    // own staging uses HR + motion here
    const own = r.all.sleepDuration!.find((x) => x.method === 'own-staging-v1')!;
    expect(own.inputsUsed).toEqual(expect.arrayContaining(['heartRate', 'steps', 'stillPeriods']));
  });

  it('stages only: stage + session methods, recovery from sleep only, no own staging', () => {
    const r = computeNightMetrics(tierNight('stagesOnly'), makeHistory(10, DATE, TIERS.stagesOnly));
    checkInvariants(r);
    expect(methods(r, 'sleepDuration')).toEqual(['stages-v1', 'session-bounds-v1']);
    expect(methods(r, 'sleepScore')).toEqual(['stages-v1', 'duration-only-v1']);
    expect(methods(r, 'recovery')).toEqual(['sleep-only-v1']);
    expect(r.best.recovery!.confidence).toBe('low');
    expect(r.all.breathing).toBeUndefined();
    expect(r.all.skinTemp).toBeUndefined();
    expect(r.all.moodLink).toBeUndefined();
  });

  it('HR only: hr-only staging, RHR derived from heart rate', () => {
    const r = computeNightMetrics(tierNight('hrOnly'), makeHistory(10, DATE, TIERS.hrOnly));
    checkInvariants(r);
    expect(methods(r, 'sleepDuration')).toEqual(['own-staging-v1']);
    expect(r.all.sleepDuration![0]!.inputsUsed).toEqual(['heartRate']);
    expect(r.all.sleepDuration![0]!.explanation).toContain('hr-only-v1');
    expect(methods(r, 'sleepScore')).toEqual(['own-staging-v1', 'duration-only-v1']);
    expect(methods(r, 'recovery')).toEqual(['rhr-v1', 'sleep-only-v1']);
    expect(r.best.recovery!.method).toBe('rhr-v1');
    expect(methods(r, 'consistency')).toEqual(['timing-sd-v1', 'sri-v1']);
  });

  it('steps + still only: actigraphy sleep/wake, no deep/REM components', () => {
    const r = computeNightMetrics(tierNight('motionOnly'), []);
    checkInvariants(r);
    expect(methods(r, 'sleepDuration')).toEqual(['own-staging-v1']);
    expect(r.all.sleepDuration![0]!.explanation).toContain('motion-only-v1');
    const own = r.all.sleepScore!.find((x) => x.method === 'own-staging-v1')!;
    expect(own.confidence).toBe('low');
    expect(own.components).not.toHaveProperty('deep');
    expect(own.components).not.toHaveProperty('rem');
    expect(methods(r, 'recovery')).toEqual(['sleep-only-v1']);
  });

  it('HR + steps, no stages: hr-motion staging at medium confidence', () => {
    const r = computeNightMetrics(tierNight('hrSteps'), []);
    checkInvariants(r);
    expect(r.all.sleepDuration![0]!.explanation).toContain('hr-motion-v1');
    expect(r.best.sleepDuration!.confidence).toBe('medium');
    expect(r.best.sleepScore!.method).toBe('own-staging-v1');
    expect(r.best.sleepScore!.confidence).toBe('medium');
    expect(r.best.sleepScore!.components).toHaveProperty('deep');
    // no session → in-bed time unknown → no latency sub-score
    expect(r.best.sleepScore!.components).not.toHaveProperty('latency');
  });

  it('nothing: empty report, no crash', () => {
    const r = computeNightMetrics(tierNight('nothing'), []);
    checkInvariants(r);
    expect(r.all).toEqual({});
    expect(r.best).toEqual({});
    expect(r.baselines).toEqual({ nights: 0 });
  });

  it('single night, no history: everything still computes, recovery is low-confidence', () => {
    const r = computeNightMetrics(tierNight('everything'), []);
    checkInvariants(r);
    expect(r.best.recovery!.method).toBe('hrv-rhr-v1');
    expect(r.best.recovery!.confidence).toBe('low');
    expect(r.best.recovery!.explanation).toContain('still learning');
    expect(r.all.consistency).toBeUndefined();
    expect(r.best.sleepDebt!.components!.nights).toBe(1);
    expect(r.best.sleepDebt!.confidence).toBe('low');
    expect(r.best.moodLink!.value).toBeNull();
    expect(r.best.moodLink!.explanation).toMatch(/6 more mornings/);
    expect(methods(r, 'skinTemp')).toEqual(['nightly-delta-v1']);
  });

  it('every tier × history combination keeps invariants', () => {
    for (const tier of Object.keys(TIERS)) {
      for (const hist of [[], makeHistory(3, DATE, TIERS[tier]), history30]) {
        const night = tierNight(tier);
        checkInvariants(computeNightMetrics(night, hist, { fajrUtc: '2026-10-08T01:30:00Z', nowUtc: '2026-10-08T09:00:00Z' }));
      }
    }
  });

  it('is deterministic', () => {
    const night = tierNight('everything');
    const a = computeNightMetrics(night, history30, { fajrUtc: '2026-10-08T01:30:00Z' });
    const b = computeNightMetrics(structuredClone(night), structuredClone(history30), { fajrUtc: '2026-10-08T01:30:00Z' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('metric behaviour', () => {
  const hist = makeHistory(30, DATE);

  it('recovery drops with low HRV / high RHR and recommends rest on a fever-like temp', () => {
    const good = computeNightMetrics(tierNight('everything', { rmssd: 55, rhr: 53, tempDeltaC: 0 }), hist);
    const bad = computeNightMetrics(tierNight('everything', { rmssd: 28, rhr: 63, tempDeltaC: 0 }), hist);
    expect(good.best.recovery!.value!).toBeGreaterThan(bad.best.recovery!.value! + 30);
    expect(good.best.recovery!.explanation).toMatch(/train hard\.$/);
    expect(bad.best.recovery!.explanation).toMatch(/rest\.$/);
    const fever = computeNightMetrics(tierNight('everything', { rmssd: 50, rhr: 55, tempDeltaC: 1.2 }), hist);
    expect(fever.best.recovery!.components!.tempPenalty).toBeGreaterThan(20);
    expect(fever.best.recovery!.explanation).toMatch(/Recommendation: rest\.$/);
    expect(fever.best.skinTemp!.explanation).toMatch(/illness/);
    expect(fever.best.skinTemp!.label).toBe('Elevated');
    expect(fever.best.recovery!.label).toBe('Rest');
    expect(good.best.recovery!.label).toBe('Train hard');
  });

  it('breathing flags unusual values in wellness language only', () => {
    const normal = computeNightMetrics(tierNight('everything', { respBrpm: 14 }), hist);
    expect(normal.all.breathing![0]!.explanation).not.toMatch(/doctor/);
    const high = computeNightMetrics(tierNight('everything', { respBrpm: 19, spo2Avg: 89 }), hist);
    for (const x of high.all.breathing!) {
      expect(x.explanation).toMatch(/unusual for you/);
      expect(x.explanation).toMatch(/not a diagnosis/);
      expect(x.explanation).toMatch(/consider talking to a doctor/);
      expect(x.components!.unusual).toBe(1);
      expect(x.label).toBe('Unusual');
    }
    const spo2 = high.all.breathing!.find((x) => x.method === 'spo2-v1')!;
    expect(spo2.components!.minutesBelow90).toBeGreaterThan(0);
  });

  it('sleep debt sums shortfall over 7 nights vs need', () => {
    const nights = Array.from({ length: 7 }, (_, i) =>
      makeNight({ dateLocal: addDaysLocal(DATE, i - 6), seed: i + 1, fields: ['stages'], sleepMin: 360 }).night,
    );
    const r = computeNightMetrics(nights[6]!, nights.slice(0, 6), { sleepNeedMin: 480 });
    expect(r.best.sleepDebt!.value).toBe(7 * 120);
    expect(r.best.sleepDebt!.confidence).toBe('high');
    expect(r.best.sleepDebt!.label).toBe('Sleep debt');
    const r2 = computeNightMetrics(nights[6]!, nights.slice(0, 6), { sleepNeedMin: 360 });
    expect(r2.best.sleepDebt!.value).toBe(0);
    expect(r2.best.sleepDebt!.label).toBe('On track');
  });

  it('consistency rewards a regular schedule over an irregular one', () => {
    const mk = (jitter: number) =>
      Array.from({ length: 14 }, (_, i) =>
        makeNight({ dateLocal: addDaysLocal(DATE, i - 13), seed: i * 3 + 1, fields: ['stages'], jitterMin: jitter }).night,
      );
    const reg = mk(5);
    const irr = mk(150);
    const a = computeNightMetrics(reg[13]!, reg.slice(0, 13));
    const b = computeNightMetrics(irr[13]!, irr.slice(0, 13));
    expect(a.best.consistency!.value!).toBeGreaterThan(b.best.consistency!.value! + 20);
    const sriA = a.all.consistency!.find((x) => x.method === 'sri-v1')!;
    const sriB = b.all.consistency!.find((x) => x.method === 'sri-v1')!;
    expect(sriA.value!).toBeGreaterThan(sriB.value!);
  });

  it('moodLink finds the sleep–mood link, low confidence below 14 nights', () => {
    const h10 = makeHistory(10, DATE);
    const r10 = computeNightMetrics(tierNight('everything', { sleepMin: 450, mood: 4 }), h10);
    expect(r10.best.moodLink!.confidence).toBe('low');
    expect(r10.best.moodLink!.value!).toBeGreaterThan(0.5);
    const r30 = computeNightMetrics(tierNight('everything', { sleepMin: 450, mood: 4 }), hist);
    expect(r30.best.moodLink!.confidence).toBe('medium');
    expect(r30.best.moodLink!.components!.n).toBe(31);
    expect(r30.best.moodLink!.explanation).toMatch(/not proof/);
  });

  it('fajrWakeEase: deep sleep around Fajr is hard, light is easy; skipped before the window ends', () => {
    const base = makeNight({ dateLocal: DATE, seed: 7 }).night;
    const fajr = new Date(Date.parse(base.session!.startUtc) + 300 * 60_000).toISOString();
    const span = { fromUtc: new Date(Date.parse(fajr) - 40 * 60_000).toISOString(), toUtc: new Date(Date.parse(fajr) + 20 * 60_000).toISOString() };
    const deep = makeNight({ dateLocal: DATE, seed: 7, forceStage: { stage: 'deep', ...span } }).night;
    const light = makeNight({ dateLocal: DATE, seed: 7, forceStage: { stage: 'light', ...span } }).night;
    const d = computeNightMetrics(deep, [], { fajrUtc: fajr }).best.fajrWakeEase!;
    const l = computeNightMetrics(light, [], { fajrUtc: fajr }).best.fajrWakeEase!;
    expect(d.method).toBe('stages-v1');
    expect(d.value!).toBeLessThan(40);
    expect(l.value!).toBeGreaterThan(70);
    expect(d.explanation).toMatch(/deep sleep/);
    expect(d.label).toBe('Hard');
    expect(l.label).toBe('Easy');
    const early = computeNightMetrics(light, [], { fajrUtc: fajr, nowUtc: fajr });
    expect(early.all.fajrWakeEase).toBeUndefined();
    expect(computeNightMetrics(light, []).all.fajrWakeEase).toBeUndefined();
  });

  it('stages still processing: falls back to session bounds, flagged in progress', () => {
    const r = computeNightMetrics(tierNight('stagesOnly', { stagesProcessed: false }), []);
    expect(methods(r, 'sleepDuration')).toEqual(['session-bounds-v1']);
    expect(r.best.sleepDuration!.explanation).toMatch(/so far/);
  });
});

describe('computeBaselines', () => {
  it('takes medians over the last N nights', () => {
    const hist = [50, 60, 52, 54, 58, 70].map((rhr, i) =>
      makeNight({ dateLocal: addDaysLocal(DATE, i - 6), seed: i + 1, fields: ['rhr', 'stages'], rhr }).night,
    );
    expect(computeBaselines(hist).restingHrBpm).toBe(56); // median of 6 values
    const b3 = computeBaselines(hist, { nights: 3 });
    expect(b3.nights).toBe(3);
    expect(b3.restingHrBpm).toBe(58);
    expect(b3.sleepMinutes).toBeGreaterThan(0);
    expect(b3.bedtimeMin).toBeLessThan(0); // ~22:40 → negative minutes
    expect(b3.waketimeMin).toBeGreaterThan(0);
    expect(b3.counts).toEqual({ restingHrBpm: 3, rmssdMs: 0, respiratoryBrpm: 0, spo2AvgPct: 0, sleepMinutes: 3, bedtimeMin: 3, waketimeMin: 3 });
    // a night missing RHR contributes to the other fields only
    const mixed = [...hist, makeNight({ dateLocal: DATE, seed: 99, fields: ['stages'] }).night];
    const bm = computeBaselines(mixed);
    expect(bm.counts!.restingHrBpm).toBe(6);
    expect(bm.counts!.sleepMinutes).toBe(7);
  });

  it('empty history', () => {
    expect(computeBaselines([])).toEqual({ nights: 0 });
  });

  it('labelFor bands', () => {
    expect(scoreLabel(80)).toBe('Great');
    expect(scoreLabel(65)).toBe('Good');
    expect(scoreLabel(50)).toBe('Fair');
    expect(scoreLabel(49)).toBe('Poor');
    expect(durationLabel(432)).toBe('7h 12m');
  });
});
