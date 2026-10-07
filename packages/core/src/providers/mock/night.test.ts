import { describe, expect, it } from 'vitest';
import { MOCK_DATA_TIERS, mockHistory, mockNightData } from './night.js';
import { generateNight } from './index.js';

const TZ = 'Asia/Riyadh';

describe('mockNightData', () => {
  const night = mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 7 });
  const stageAt = new Map(
    night.session!.stages.flatMap((seg) => {
      const out: [string, string][] = [];
      for (let t = Date.parse(seg.startUtc); t < Date.parse(seg.endUtc); t += 60_000) out.push([new Date(t).toISOString(), seg.stage]);
      return out;
    }),
  );
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('is deterministic by seed (and by date when no seed is given)', () => {
    expect(mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 7 })).toEqual(night);
    expect(mockNightData({ dateLocal: '2026-10-08', tz: TZ })).toEqual(mockNightData({ dateLocal: '2026-10-08', tz: TZ }));
    expect(mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 8 })).not.toEqual(night);
  });

  it('fills every field and the night ends on dateLocal (local time)', () => {
    for (const f of ['session', 'stagesProcessed', 'heartRate', 'hrv', 'dailyHrv', 'restingHrBpm', 'spo2', 'dailySpo2', 'respiratory', 'skinTempDeltaC', 'steps', 'stillPeriods']) {
      expect(night, f).toHaveProperty(f);
    }
    expect(night.session!.tzOffsetMin).toBe(180);
    const endLocal = new Date(Date.parse(night.session!.endUtc) + 180 * 60_000).toISOString().slice(0, 10);
    expect(endLocal).toBe('2026-10-08');
  });

  it('uses the same stage generator as the mock wake provider', () => {
    const start = new Date(night.session!.startUtc);
    const minutes = night.heartRate!.length;
    const stages = generateNight(start, minutes / 60, 7).map((s) => s.stage);
    expect(night.heartRate!.map((h) => stageAt.get(h.tsUtc))).toEqual(stages);
  });

  it('is physiologically plausible: HR dips and HRV rises in deep sleep', () => {
    const hrIn = (st: string) => avg(night.heartRate!.filter((h) => stageAt.get(h.tsUtc) === st).map((h) => h.value));
    const hrvIn = (st: string) => avg(night.hrv!.filter((h) => stageAt.get(h.tsUtc) === st).map((h) => h.rmssdMs!));
    expect(hrIn('deep')).toBeLessThan(hrIn('light'));
    expect(hrIn('light')).toBeLessThan(hrIn('awake'));
    expect(hrvIn('deep')).toBeGreaterThan(hrvIn('light'));
    expect(hrvIn('light')).toBeGreaterThan(hrvIn('rem'));
    expect(night.dailyHrv!.deepSleepRmssdMs!).toBeGreaterThan(night.dailyHrv!.rmssdMs!);
    expect(night.restingHrBpm!).toBeGreaterThan(45);
    expect(night.restingHrBpm!).toBeLessThan(65);
  });

  it('breathing ~14, SpO2 95–98, steps 0 asleep, still periods, small temp delta', () => {
    const r = night.respiratory!;
    expect(r.fullSleepBrpm!).toBeGreaterThan(12);
    expect(r.fullSleepBrpm!).toBeLessThan(16);
    expect(r.deepBrpm!).toBeLessThan(r.lightBrpm!);
    expect(r.lightBrpm!).toBeLessThan(r.remBrpm!);
    expect(night.spo2!.every((s) => s.value >= 95 && s.value <= 98)).toBe(true);
    expect(night.dailySpo2!.lowerPct!).toBeLessThanOrEqual(night.dailySpo2!.avgPct);
    const asleepSteps = night.steps!.filter((s) => ['light', 'deep', 'rem'].includes(stageAt.get(s.tsUtc) ?? ''));
    expect(asleepSteps.length).toBeGreaterThan(300);
    expect(asleepSteps.every((s) => s.value === 0)).toBe(true);
    const stillMin = night.stillPeriods!.reduce((m, p) => m + (Date.parse(p.endUtc) - Date.parse(p.startUtc)) / 60_000, 0);
    expect(stillMin).toBeGreaterThan(0.8 * night.heartRate!.length);
    expect(Math.abs(night.skinTempDeltaC!)).toBeLessThan(0.5);
  });

  it('tiers and drop remove fields to emulate partial data', () => {
    const hrOnly = mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 7, tier: 'hr-only' });
    expect(Object.keys(hrOnly).sort()).toEqual(['dateLocal', 'heartRate', 'tz']);
    const noStages = mockNightData({ dateLocal: '2026-10-08', tz: TZ, seed: 7, tier: 'no-stages', drop: ['spo2'] });
    expect(noStages.session).toBeUndefined();
    expect(noStages.spo2).toBeUndefined();
    expect(noStages.heartRate).toEqual(night.heartRate);
    expect(Object.keys(mockNightData({ dateLocal: '2026-10-08', tz: TZ, tier: 'none' })).sort()).toEqual(['dateLocal', 'tz']);
    expect(MOCK_DATA_TIERS.full).toEqual([]);
  });
});

describe('mockHistory', () => {
  it('returns n consecutive nights oldest → newest, deterministic and varied', () => {
    const h = mockHistory(30, { endDateLocal: '2026-10-08', tz: TZ, seed: 3 });
    expect(h).toHaveLength(30);
    expect(h[0]!.dateLocal).toBe('2026-09-09');
    expect(h[29]!.dateLocal).toBe('2026-10-08');
    expect(h.map((n) => n.dateLocal)).toEqual([...h.map((n) => n.dateLocal)].sort());
    expect(mockHistory(30, { endDateLocal: '2026-10-08', tz: TZ, seed: 3 })).toEqual(h);
    const rhr = new Set(h.map((n) => n.restingHrBpm));
    expect(rhr.size).toBeGreaterThan(2);
    // Each night's session ends on its own local date.
    for (const n of h) {
      const endLocal = new Date(Date.parse(n.session!.endUtc) + n.session!.tzOffsetMin * 60_000).toISOString().slice(0, 10);
      expect(endLocal).toBe(n.dateLocal);
    }
    expect(mockHistory(5, { endDateLocal: '2026-10-08', tz: TZ, tier: 'summaries-only' }).every((n) => !n.heartRate && n.dailyHrv)).toBe(true);
  });
});
