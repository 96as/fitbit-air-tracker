import { describe, expect, it } from 'vitest';
import { mapHeartRate, mapSleep, parseUtcOffsetMinutes, toSamples } from './mapping.js';
import type { GhListDataPointsResponse } from './types.js';
import stagesFixture from './__fixtures__/sleep-stages.json';
import classicFixture from './__fixtures__/sleep-classic.json';
import inProgressFixture from './__fixtures__/sleep-inprogress.json';
import hrFixture from './__fixtures__/heart-rate.json';

const stages = stagesFixture as GhListDataPointsResponse;
const classic = classicFixture as GhListDataPointsResponse;
const inProgress = inProgressFixture as GhListDataPointsResponse;
const hr = hrFixture as GhListDataPointsResponse;

describe('parseUtcOffsetMinutes', () => {
  it('parses protobuf durations and ±HH:MM', () => {
    expect(parseUtcOffsetMinutes('10800s')).toBe(180);
    expect(parseUtcOffsetMinutes('-18000s')).toBe(-300);
    expect(parseUtcOffsetMinutes('+05:30')).toBe(330);
    expect(parseUtcOffsetMinutes('-0400')).toBe(-240);
    expect(parseUtcOffsetMinutes(undefined)).toBe(0);
  });
});

describe('mapSleep', () => {
  it('maps a staged session with every stage enum normalized', () => {
    const s = mapSleep(stages.dataPoints![0]!, 'u1')!;
    expect(s.id).toBe('users/me/dataTypes/sleep/dataPoints/44598780531');
    expect(s.source).toBe('google_health');
    expect(s.startUtc).toBe('2026-07-03T20:12:00.000Z');
    expect(s.endUtc).toBe('2026-07-04T01:40:00.000Z');
    expect(s.tzOffsetMin).toBe(180);
    expect(s.isNap).toBe(false);
    expect(s.efficiencyPct).toBeCloseTo(95.1, 1);
    expect(s.meta).toMatchObject({ processed: true, mainSleep: true, sleepType: 'STAGES' });
    expect(s.stages.map((x) => x.stage)).toEqual([
      'awake', 'light', 'deep', 'light', 'rem', 'light', 'deep', 'awake', 'rem', 'light', 'awake',
    ]);
  });

  it('maps a classic nap (no stages) as one light segment', () => {
    const s = mapSleep(classic.dataPoints![0]!, 'u1')!;
    expect(s.isNap).toBe(true);
    expect(s.tzOffsetMin).toBe(-300);
    expect(s.stages).toEqual([{ stage: 'light', startUtc: '2026-07-04T11:05:00.000Z', endUtc: '2026-07-04T11:40:00.000Z' }]);
    expect(s.meta.sleepType).toBe('CLASSIC');
  });

  it('keeps the unprocessed flag for in-progress nights', () => {
    const s = mapSleep(inProgress.dataPoints![0]!, 'u1')!;
    expect(s.meta.processed).toBe(false);
    expect(s.efficiencyPct).toBeUndefined();
  });

  it('returns undefined for points without a sleep interval', () => {
    expect(mapSleep({ name: 'x' }, 'u1')).toBeUndefined();
  });
});

describe('mapHeartRate', () => {
  it('parses string and numeric bpm', () => {
    const points = hr.dataPoints!.map(mapHeartRate);
    expect(points.map((p) => p?.bpm)).toEqual([54, 55, 57, 58]);
    expect(points[0]?.tsUtc).toBe('2026-07-04T23:30:00.000Z');
  });
});

describe('toSamples', () => {
  it('expands stages per minute and attaches the nearest heart rate within tolerance', () => {
    const session = mapSleep(inProgress.dataPoints![0]!, 'u1')!;
    const hrs = hr.dataPoints!.map(mapHeartRate).filter((h): h is NonNullable<typeof h> => Boolean(h));
    const samples = toSamples([session], hrs, new Date('2026-07-04T23:20:00Z'));
    expect(samples[0]!.tsUtc).toBe('2026-07-04T23:20:00.000Z');
    expect(samples.at(-1)!.tsUtc).toBe('2026-07-04T23:44:00.000Z'); // end exclusive
    expect(samples.every((s) => s.stage === 'light')).toBe(true);
    const at2331 = samples.find((s) => s.tsUtc === '2026-07-04T23:31:00.000Z')!;
    expect(at2331.heartRateBpm).toBe(54); // 1 min from 23:30 reading
    const at2322 = samples.find((s) => s.tsUtc === '2026-07-04T23:22:00.000Z')!;
    expect(at2322.heartRateBpm).toBeUndefined(); // 8 min from nearest reading > 5 min tolerance
  });

  it('drives the wake decision the same way mock data does', async () => {
    const { decide } = await import('../../wake/decide.js');
    const session = mapSleep(inProgress.dataPoints![0]!, 'u1')!;
    const samples = toSamples([session], [], new Date('2026-07-04T22:00:00Z'));
    const now = new Date('2026-07-04T23:50:00Z'); // newest sample 23:44 → 6 min old, fresh
    const d = decide({ now, deadline: new Date('2026-07-05T00:30:00Z'), preferredStages: ['light', 'awake'], samples });
    expect(d).toMatchObject({ action: 'fire', reason: 'light-sleep' });
  });
});
