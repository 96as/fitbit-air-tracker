import { describe, expect, it } from 'vitest';
import { MockSleepProvider, generateNight } from '../providers/mock/index.js';
import { WakeScheduler, type ScheduledAlarm, type FireDecision } from './scheduler.js';
import type { AlarmPolicy, Clock, SleepSample } from '../types.js';
import type { SleepDataProvider } from '../providers/types.js';

/**
 * Accelerated end-to-end simulation: a full night runs in milliseconds by
 * stepping a fake clock minute-by-minute and ticking the scheduler, exactly
 * as the 30 s production timer would.
 */

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(n: number): void {
    this.current = new Date(this.current.getTime() + n * 60_000);
  }
}

const policy: AlarmPolicy = {
  id: 'p1',
  userId: 'u1',
  prayer: 'fajr',
  enabled: true,
  windowMinutes: 45,
  deadlineOffsetMinutes: 20,
  preferredStages: ['light', 'awake'],
  snoozeMinutes: 5,
  maxSnoozes: 2,
};

async function runNight(
  provider: SleepDataProvider,
  clock: FakeClock,
  prayerTimeUtc: Date,
): Promise<{ alarm: ScheduledAlarm; decision: FireDecision; firedAt: Date } | undefined> {
  let result: { alarm: ScheduledAlarm; decision: FireDecision; firedAt: Date } | undefined;
  const scheduler = new WakeScheduler({
    clock,
    provider,
    onFire: (alarm, decision) => {
      result = { alarm, decision, firedAt: clock.now() };
    },
  });
  scheduler.schedule(policy, prayerTimeUtc);
  // Step through the night one simulated minute at a time.
  for (let i = 0; i < 10 * 60 && !result; i++) {
    await scheduler.tick();
    clock.advanceMinutes(1);
  }
  return result;
}

describe('wake engine — accelerated night simulation', () => {
  it('fires during light sleep inside the window, before the hard deadline', async () => {
    const sleepStart = new Date('2026-07-03T22:00:00Z');
    const clock = new FakeClock(sleepStart);
    const provider = new MockSleepProvider({
      clock,
      syncLagMin: 15, // honest Fitbit Air sync behavior
      sleepStartUtc: sleepStart,
      nightHours: 8,
      seed: 42,
    });
    const fajr = new Date('2026-07-04T04:30:00Z'); // 6.5 h into the night

    const result = await runNight(provider, clock, fajr);

    expect(result).toBeDefined();
    const deadline = new Date(fajr.getTime() - policy.deadlineOffsetMinutes * 60_000);
    const windowStart = new Date(deadline.getTime() - policy.windowMinutes * 60_000);
    expect(result!.firedAt.getTime()).toBeGreaterThanOrEqual(windowStart.getTime());
    expect(result!.firedAt.getTime()).toBeLessThanOrEqual(deadline.getTime());
    // The mock night has light/REM phases in the window, so with seed 42 the
    // engine should beat the deadline using telemetry, not the fallback.
    expect(['light-sleep', 'hr-rise']).toContain(result!.decision.reason);
  });

  it('falls back to the hard deadline when the sleeper never leaves deep sleep', async () => {
    const sleepStart = new Date('2026-07-03T22:00:00Z');
    const clock = new FakeClock(sleepStart);
    const stuckInDeepSleep: SleepDataProvider = {
      name: 'mock',
      async getLatestSamples(_userId, since): Promise<SleepSample[]> {
        // Fresh data every tick, but always deep sleep with a flat heart rate.
        const now = clock.now();
        const samples: SleepSample[] = [];
        for (let t = since.getTime(); t <= now.getTime(); t += 60_000) {
          samples.push({ tsUtc: new Date(t).toISOString(), stage: 'deep', heartRateBpm: 52 });
        }
        return samples;
      },
      async getSessions() {
        return [];
      },
    };
    const fajr = new Date('2026-07-04T04:30:00Z');

    const result = await runNight(stuckInDeepSleep, clock, fajr);

    expect(result).toBeDefined();
    expect(result!.decision.reason).toBe('deadline');
    const deadline = new Date(fajr.getTime() - policy.deadlineOffsetMinutes * 60_000);
    // Fired at the deadline (within one tick of clock granularity), never after the prayer.
    expect(result!.firedAt.getTime()).toBeGreaterThanOrEqual(deadline.getTime());
    expect(result!.firedAt.getTime()).toBeLessThanOrEqual(deadline.getTime() + 60_000);
  });

  it('still fires at the deadline when the provider throws (dead/unauthenticated provider)', async () => {
    const sleepStart = new Date('2026-07-03T22:00:00Z');
    const clock = new FakeClock(sleepStart);
    const errors: unknown[] = [];
    const deadProvider: SleepDataProvider = {
      name: 'google_health',
      async getLatestSamples() {
        throw new Error('not connected to Google');
      },
      async getSessions() {
        return [];
      },
    };
    const fajr = new Date('2026-07-04T04:30:00Z');
    let result: { decision: FireDecision; firedAt: Date } | undefined;
    const scheduler = new WakeScheduler({
      clock,
      provider: deadProvider,
      onFire: (_a, decision) => {
        result = { decision, firedAt: clock.now() };
      },
      onError: (e) => errors.push(e),
    });
    scheduler.schedule(policy, fajr);
    for (let i = 0; i < 10 * 60 && !result; i++) {
      await scheduler.tick();
      clock.advanceMinutes(1);
    }
    expect(result!.decision.reason).toBe('deadline');
    expect(errors.length).toBeGreaterThan(0);
  });

  describe('late data (Fitbit Air syncs ~15 min behind): cycle predictor', () => {
    const fajrPolicy: AlarmPolicy = { ...policy, deadlineOffsetMinutes: -15 }; // latest wake 15 min after adhan

    /** Simulate one mock night; report why/when it fired and the TRUE stage at that minute. */
    async function lateNight(seed: number, lagMin: number, predictive: boolean) {
      const sleepStart = new Date('2026-07-03T22:00:00Z');
      const truth = generateNight(sleepStart, 9, seed);
      const fajr = new Date(sleepStart.getTime() + (330 + ((seed * 37) % 120)) * 60_000);
      const deadline = new Date(fajr.getTime() + 15 * 60_000);
      const windowStart = new Date(deadline.getTime() - fajrPolicy.windowMinutes * 60_000);
      const clock = new FakeClock(new Date(windowStart.getTime() - 2 * 60_000));
      const provider = new MockSleepProvider({ clock, syncLagMin: lagMin, sleepStartUtc: sleepStart, nightHours: 9, seed });
      let fired: { decision: FireDecision; at: Date } | undefined;
      const scheduler = new WakeScheduler({ clock, provider, predictive, onFire: (_a, decision) => void (fired = { decision, at: clock.now() }) });
      scheduler.schedule(fajrPolicy, fajr);
      for (let i = 0; i < 120 && !fired; i++) {
        await scheduler.tick();
        clock.advanceMinutes(1);
      }
      const stage = truth.find((x) => x.tsUtc === fired!.at.toISOString())?.stage;
      return { reason: fired!.decision.reason, at: fired!.at, stage, windowStart, deadline };
    }
    const easy = (s?: string) => s === 'light' || s === 'awake';

    it('with a 15-min lag, fires in TRUE light sleep far more often — never outside the window', async () => {
      let legacyGood = 0;
      let good = 0;
      let predicted = 0;
      let predictedGood = 0;
      const N = 60;
      for (let seed = 1; seed <= N; seed++) {
        const legacy = await lateNight(seed, 15, false);
        const r = await lateNight(seed, 15, true);
        for (const x of [legacy, r]) {
          expect(x.at.getTime()).toBeGreaterThanOrEqual(x.windowStart.getTime()); // no early fire
          expect(x.at.getTime()).toBeLessThanOrEqual(x.deadline.getTime()); // invariant 1
        }
        if (easy(legacy.stage)) legacyGood++;
        if (easy(r.stage)) good++;
        if (r.reason === 'predicted-light') {
          predicted++;
          if (easy(r.stage)) predictedGood++;
        }
      }
      expect(predicted).toBeGreaterThan(N / 3);
      expect(predictedGood / predicted).toBeGreaterThanOrEqual(0.85);
      expect(good / N).toBeGreaterThanOrEqual(0.7);
      expect(good - legacyGood).toBeGreaterThanOrEqual(N / 5); // ≥ 20 points better than firing on stale stages
    });

    it('with a 25-min lag (stale for the stage rule) the predictor still wakes in light sleep', async () => {
      let predicted = 0;
      let predictedGood = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const r = await lateNight(seed, 25, true);
        expect(r.at.getTime()).toBeGreaterThanOrEqual(r.windowStart.getTime());
        expect(r.at.getTime()).toBeLessThanOrEqual(r.deadline.getTime());
        expect(['predicted-light', 'deadline']).toContain(r.reason);
        if (r.reason === 'predicted-light') {
          predicted++;
          if (easy(r.stage)) predictedGood++;
        }
      }
      expect(predicted).toBeGreaterThan(20);
      expect(predictedGood / predicted).toBeGreaterThanOrEqual(0.85);
    });

    it('fires on a crafted night exactly when REM has (truly) ended, using 15-min-old data', async () => {
      const sleepStart = new Date('2026-07-03T22:00:00Z');
      const runs: Array<[SleepSample['stage'], number]> = [['awake', 10]];
      for (let c = 0; c < 4; c++) runs.push(['light', 20], ['deep', 20], ['light', 20], ['rem', 30]);
      runs.push(['light', 25], ['deep', 20]);
      const truth: SleepSample[] = [];
      for (const [stage, m] of runs) for (let i = 0; i < m; i++) truth.push({ tsUtc: new Date(sleepStart.getTime() + truth.length * 60_000).toISOString(), stage, heartRateBpm: 55 });
      const clock = new FakeClock(sleepStart);
      const lagged: SleepDataProvider = {
        name: 'mock',
        async getLatestSamples(_u, since) {
          const visible = clock.now().getTime() - 15 * 60_000;
          return truth.filter((x) => Date.parse(x.tsUtc) >= since.getTime() && Date.parse(x.tsUtc) <= visible);
        },
        async getSessions() {
          return [];
        },
      };
      // 4th REM ends at minute 370; window opens at 350 (REM visible until 335).
      const deadline = new Date(sleepStart.getTime() + 395 * 60_000);
      const fajr = new Date(deadline.getTime() - 15 * 60_000);
      let fired: { decision: FireDecision; at: Date } | undefined;
      const scheduler = new WakeScheduler({ clock, provider: lagged, onFire: (_a, decision) => void (fired = { decision, at: clock.now() }) });
      scheduler.schedule(fajrPolicy, fajr);
      clock.advanceMinutes(345);
      for (let i = 0; i < 60 && !fired; i++) {
        await scheduler.tick();
        clock.advanceMinutes(1);
      }
      expect(fired!.decision.reason).toBe('predicted-light');
      const minute = (fired!.at.getTime() - sleepStart.getTime()) / 60_000;
      expect(minute).toBeGreaterThanOrEqual(370); // never inside REM
      expect(truth[minute]!.stage).toBe('light');
    });

    it('prediction impossible (stuck in deep, 15-min-late data) → the deadline still fires', async () => {
      const sleepStart = new Date('2026-07-03T22:00:00Z');
      const clock = new FakeClock(sleepStart);
      const stuckLate: SleepDataProvider = {
        name: 'mock',
        async getLatestSamples(_u, since) {
          const out: SleepSample[] = [];
          for (let t = Math.max(since.getTime(), sleepStart.getTime()); t <= clock.now().getTime() - 15 * 60_000; t += 60_000) {
            out.push({ tsUtc: new Date(t).toISOString(), stage: 'deep', heartRateBpm: 52 });
          }
          return out;
        },
        async getSessions() {
          return [];
        },
      };
      const fajr = new Date('2026-07-04T04:30:00Z');
      const result = await runNight(stuckLate, clock, fajr);
      expect(result!.decision.reason).toBe('deadline');
      const deadline = new Date(fajr.getTime() - policy.deadlineOffsetMinutes * 60_000);
      expect(result!.firedAt.getTime()).toBeLessThanOrEqual(deadline.getTime() + 60_000);
    });
  });
});
