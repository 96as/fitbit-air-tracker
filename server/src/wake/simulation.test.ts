import { describe, expect, it } from 'vitest';
import { MockSleepProvider } from '../providers/mock/index.js';
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
});
