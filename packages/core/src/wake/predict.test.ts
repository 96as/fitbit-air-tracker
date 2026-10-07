import { describe, expect, it } from 'vitest';
import { predictLightWindow, segmentsFromSamples } from './predict.js';
import { decide } from './decide.js';
import type { SleepSample, SleepStage, SleepStageSegment } from '../types.js';

const T0 = Date.parse('2026-07-03T22:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);

/** Build segments from [stage, minutes] runs starting at T0. */
function night(runs: Array<[SleepStage, number]>): { segments: SleepStageSegment[]; end: number } {
  let t = 0;
  const segments = runs.map(([stage, m]) => {
    const seg = { stage, startUtc: at(t).toISOString(), endUtc: at(t + m).toISOString() };
    t += m;
    return seg;
  });
  return { segments, end: t };
}

function samples(runs: Array<[SleepStage, number]>): SleepSample[] {
  const out: SleepSample[] = [];
  let t = 0;
  for (const [stage, m] of runs) for (let i = 0; i < m; i++) out.push({ tsUtc: at(t++).toISOString(), stage, heartRateBpm: 55 });
  return out;
}

// Three regular 90-min cycles after 10 min latency, then the 4th cycle in progress.
const CYCLE: Array<[SleepStage, number]> = [['light', 20], ['deep', 20], ['light', 20], ['rem', 30]];
const REGULAR: Array<[SleepStage, number]> = [['awake', 10], ...CYCLE, ...CYCLE, ...CYCLE];

describe('predictLightWindow', () => {
  it('needs sleep to predict anything', () => {
    const { segments, end } = night([['awake', 30]]);
    expect(predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 15) })).toEqual({ ok: false, reason: 'no-sleep-yet' });
  });

  it('personalizes the cycle length from ≥ 2 complete cycles', () => {
    const { segments, end } = night([...REGULAR, ['light', 10]]);
    const p = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 15) });
    expect(p).toMatchObject({ ok: true, personalized: true, completeCycles: 3, cycleMin: 90 });
  });

  it('falls back to a 90-min cycle with < 2 complete cycles', () => {
    const { segments, end } = night([['awake', 10], ['light', 20], ['deep', 25]]);
    const p = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 15) });
    expect(p).toMatchObject({ ok: true, personalized: false, cycleMin: 90 });
  });

  it('data ends mid-REM → predicts the post-REM light window', () => {
    // 4th cycle: light 20, deep 20, light 20, then REM for 20 of its expected 30 min.
    const { segments, end } = night([...REGULAR, ...CYCLE.slice(0, 3), ['rem', 20]]);
    const p = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 15) });
    if (!p.ok) throw new Error(p.reason);
    // REM ends ≈ end+10 → light until ≈ end+30, minus margins.
    expect(p.stageNow).toBe('light');
    expect(p.inWindow).toBe(true);
    expect(Date.parse(p.next!.startUtc)).toBeGreaterThan(at(end + 10).getTime());
    expect(Date.parse(p.next!.endUtc)).toBeLessThan(at(end + 30).getTime());
    // 5 min after the frontier we are still predicted in REM.
    const early = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 5) });
    expect(early).toMatchObject({ ok: true, inWindow: false, stageNow: 'rem' });
  });

  it('data ends in deep sleep → not light now, light after deep + margin', () => {
    const { segments, end } = night([...REGULAR, ['light', 20], ['deep', 5]]);
    const p = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 10) });
    expect(p).toMatchObject({ ok: true, inWindow: false, stageNow: 'deep' });
    if (!p.ok) return;
    expect(Date.parse(p.next!.startUtc)).toBeGreaterThan(at(end + 15).getTime());
  });

  it('carries tonight’s REM-lengthening trend into the next cycle', () => {
    const grow: Array<[SleepStage, number]> = [
      ['awake', 10],
      ['light', 20], ['deep', 30], ['light', 15], ['rem', 15],
      ['light', 20], ['deep', 25], ['light', 15], ['rem', 25],
      ['light', 20], ['deep', 20], ['light', 15], ['rem', 35],
      ['light', 20], ['deep', 15], ['light', 15], ['rem', 30], // REM still going (expected ≈ 45)
    ];
    const { segments, end } = night(grow);
    const p = predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 8) });
    // Without the trend the template (REM 35) would call light already at end+5.
    expect(p).toMatchObject({ ok: true, inWindow: false, stageNow: 'rem' });
  });

  it('refuses to predict when the night does not fit the model', () => {
    const { segments, end } = night([...REGULAR, ['deep', 90]]);
    expect(predictLightWindow({ segments, lastDataUtc: at(end), nowUtc: at(end + 15) })).toEqual({ ok: false, reason: 'model-mismatch:run-too-long' });
  });

  it('segmentsFromSamples collapses per-minute samples', () => {
    expect(segmentsFromSamples(samples([['light', 2], ['deep', 3]]))).toEqual([
      { stage: 'light', startUtc: at(0).toISOString(), endUtc: at(2).toISOString() },
      { stage: 'deep', startUtc: at(2).toISOString(), endUtc: at(5).toISOString() },
    ]);
  });
});

describe('decide — predicted-light rule', () => {
  const hist = samples([...REGULAR, ...CYCLE.slice(0, 3), ['rem', 20]]);
  const frontier = hist.length; // minutes
  const base = { deadline: at(frontier + 60), preferredStages: ['light', 'awake'] as SleepStage[], samples: hist, history: hist };

  it('fires when now is predicted light, inside the window, with 15-min-old data', () => {
    const d = decide({ ...base, now: at(frontier + 15), windowStart: at(frontier) });
    expect(d).toMatchObject({ action: 'fire', reason: 'predicted-light' });
    expect(d.detail).toContain('(personal)');
  });

  it('never fires before the window starts or without a window', () => {
    expect(decide({ ...base, now: at(frontier + 15), windowStart: at(frontier + 16) }).action).toBe('wait');
    expect(decide({ ...base, now: at(frontier + 15) }).action).toBe('wait');
  });

  it('can be switched off, and does not act on data older than 30 min', () => {
    expect(decide({ ...base, now: at(frontier + 15), windowStart: at(frontier), predictive: false }).action).toBe('wait');
    const old = samples([...REGULAR, ...CYCLE.slice(0, 3), ['rem', 5]]);
    expect(decide({ ...base, samples: old, history: old, now: at(old.length + 35), windowStart: at(old.length) }).detail).toContain('stale');
  });

  it('the deadline still comes first', () => {
    expect(decide({ ...base, now: at(frontier + 60), windowStart: at(frontier) })).toEqual({ action: 'fire', reason: 'deadline' });
  });

  it('gates stale light when the cycle model says the sleeper has moved on', () => {
    // Light run that by now (15 min later) should have turned into deep sleep.
    const h = samples([...REGULAR, ['light', 18]]);
    const now = at(h.length + 14);
    const input = { now, deadline: at(h.length + 90), preferredStages: ['light', 'awake'] as SleepStage[], samples: h, history: h, windowStart: at(h.length) };
    expect(decide(input).action).toBe('wait');
    expect(decide({ ...input, gateStaleLight: false })).toMatchObject({ action: 'fire', reason: 'light-sleep' });
    // Fresh light (< 5 min old) is the truth and always fires.
    expect(decide({ ...input, now: at(h.length + 2) })).toMatchObject({ action: 'fire', reason: 'light-sleep' });
  });
});
