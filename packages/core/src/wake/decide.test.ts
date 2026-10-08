import { describe, expect, it } from 'vitest';
import { decide } from './decide.js';
import type { SleepSample, SleepStage } from '../types.js';

const T0 = new Date('2026-07-04T02:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function samplesEndingAt(end: Date, stages: SleepStage[], bpm = 55): SleepSample[] {
  return stages.map((stage, i) => ({
    tsUtc: new Date(end.getTime() - (stages.length - 1 - i) * 60_000).toISOString(),
    stage,
    heartRateBpm: bpm,
  }));
}

describe('decide', () => {
  it('always fires at the deadline, even with no data', () => {
    const d = decide({ now: min(60), deadline: min(60), preferredStages: ['light'], samples: [] });
    expect(d).toEqual({ action: 'fire', reason: 'deadline' });
  });

  it('waits when there is no data before the deadline', () => {
    const d = decide({ now: min(0), deadline: min(60), preferredStages: ['light'], samples: [] });
    expect(d.action).toBe('wait');
  });

  it('fires on light sleep with fresh data', () => {
    const samples = samplesEndingAt(min(-5), ['deep', 'deep', 'light', 'light', 'light']);
    const d = decide({ now: min(0), deadline: min(60), preferredStages: ['light', 'awake'], samples });
    expect(d).toMatchObject({ action: 'fire', reason: 'light-sleep' });
  });

  it('waits during deep sleep', () => {
    const samples = samplesEndingAt(min(-5), ['light', 'deep', 'deep', 'deep', 'deep']);
    const d = decide({ now: min(0), deadline: min(60), preferredStages: ['light', 'awake'], samples });
    expect(d.action).toBe('wait');
  });

  it('ignores stale data (older than the staleness limit)', () => {
    const samples = samplesEndingAt(min(-30), ['light', 'light', 'light']);
    const d = decide({
      now: min(0),
      deadline: min(60),
      preferredStages: ['light'],
      samples,
      stalenessLimitMin: 20,
    });
    expect(d.action).toBe('wait');
    expect(d.detail).toContain('stale');
  });

  it('fires on a clear heart-rate rise even in a non-preferred stage', () => {
    const baseline = samplesEndingAt(min(-11), Array(20).fill('deep') as SleepStage[], 52);
    const rising = samplesEndingAt(min(-1), Array(10).fill('rem') as SleepStage[], 66);
    const d = decide({
      now: min(0),
      deadline: min(60),
      preferredStages: ['light'],
      samples: [...baseline, ...rising],
    });
    expect(d).toMatchObject({ action: 'fire', reason: 'hr-rise' });
  });
});
