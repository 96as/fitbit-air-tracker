import { describe, expect, it } from 'vitest';
import { planAlarms, chainTimes } from './plan.js';
import type { WakeAlarm } from '../types.js';
import { wallTimeToUtc, tzOffsetMinutes } from '../util/tz.js';

const tz = 'Africa/Cairo'; // UTC+3 in summer 2026
const now = new Date('2026-07-04T15:00:00Z'); // 18:00 Cairo

const base = {
  userId: 'u1',
  enabled: true,
  windowMinutes: 30,
  deadlineOffsetMinutes: 20,
  preferredStages: ['light', 'awake'] as WakeAlarm['preferredStages'],
  snoozeMinutes: 5,
  maxSnoozes: 2,
};

const timings = {
  '2026-07-04': { fajr: '2026-07-04T01:15:00.000Z', lastthird: '2026-07-04T22:30:00.000Z' },
  '2026-07-05': { fajr: '2026-07-05T01:15:00.000Z', lastthird: '2026-07-05T22:30:00.000Z' },
};

describe('tz helpers', () => {
  it('converts local wall time to UTC with the zone offset', () => {
    expect(tzOffsetMinutes(now, tz)).toBe(180);
    expect(wallTimeToUtc('2026-07-05', '06:30', tz).toISOString()).toBe('2026-07-05T03:30:00.000Z');
  });
});

describe('planAlarms', () => {
  it('anchors prayer alarms to timings and skips ones already past', () => {
    const fajr: WakeAlarm = { ...base, id: 'fajr', kind: 'prayer', prayer: 'fajr' };
    const planned = planAlarms({ alarms: [fajr], timings, tz, now, daysAhead: 1 });
    expect(planned).toHaveLength(1); // today's Fajr is past; tomorrow's is planned
    expect(planned[0]!.deadlineUtc).toBe('2026-07-05T00:55:00.000Z');
    expect(planned[0]!.windowStartUtc).toBe('2026-07-05T00:25:00.000Z');
    expect(planned[0]!.prayerTimeUtc).toBe('2026-07-05T01:15:00.000Z');
  });

  it('plans custom alarms at the local wall time, rolling to tomorrow when passed', () => {
    const custom: WakeAlarm = { ...base, id: 'c1', kind: 'custom', prayer: 'fajr', customTime: '06:30', windowMinutes: 0 };
    const planned = planAlarms({ alarms: [custom], timings: {}, tz, now, daysAhead: 1 });
    expect(planned.map((p) => p.deadlineUtc)).toEqual(['2026-07-05T03:30:00.000Z']);
    expect(planned[0]!.windowStartUtc).toBe(planned[0]!.deadlineUtc); // exact alarm
  });

  it('respects weekday filters', () => {
    // 2026-07-05 is a Sunday (0); allow only Monday (1) → first hit is 07-06
    const custom: WakeAlarm = { ...base, id: 'c2', kind: 'custom', prayer: 'fajr', customTime: '06:00', days: [1] };
    const planned = planAlarms({ alarms: [custom], timings: {}, tz, now, daysAhead: 7 });
    expect(planned[0]!.deadlineUtc).toBe('2026-07-06T03:00:00.000Z');
    expect(planned).toHaveLength(1);
  });

  it('sorts soonest-first and attaches the backup chain only to the next alarm', () => {
    const fajr: WakeAlarm = { ...base, id: 'fajr', kind: 'prayer', prayer: 'fajr' };
    const custom: WakeAlarm = { ...base, id: 'c1', kind: 'custom', prayer: 'fajr', customTime: '22:00' };
    const planned = planAlarms({ alarms: [fajr, custom], timings, tz, now, daysAhead: 1 });
    expect(planned[0]!.alarmId).toBe('c1'); // 22:00 tonight comes before tomorrow's Fajr
    expect(planned[0]!.chainTimesUtc.length).toBeGreaterThan(0);
    expect(planned.slice(1).every((p) => p.chainTimesUtc.length === 0)).toBe(true);
  });

  it('chain: starts after the delay, repeats at the interval, stays well under iOS 64-pending cap', () => {
    const times = chainTimes(new Date('2026-07-05T00:55:00Z'));
    expect(times[0]).toBe('2026-07-05T00:56:00.000Z');
    expect(times[1]).toBe('2026-07-05T00:56:30.000Z');
    expect(times.length).toBe(21);
  });
});
