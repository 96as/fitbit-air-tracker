import type { AlarmPolicy, Clock, Decision } from '../types.js';
import type { SleepDataProvider } from '../providers/types.js';
import { decide } from './decide.js';

export interface ScheduledAlarm {
  policy: AlarmPolicy;
  prayerTimeUtc: Date;
  deadlineUtc: Date;
  windowStartUtc: Date;
  fired: boolean;
}

export type FireDecision = Extract<Decision, { action: 'fire' }>;

export interface WakeSchedulerOptions {
  clock: Clock;
  provider: SleepDataProvider;
  onFire: (alarm: ScheduledAlarm, decision: FireDecision) => void | Promise<void>;
  stalenessLimitMin?: number;
}

const MINUTE_MS = 60_000;

/**
 * Holds tonight's scheduled alarms and evaluates them on every tick.
 * Ticks come from a timer (≤60 s cadence) AND from webhook arrivals, so fresh
 * data is acted on immediately. Clock + provider are injected, which is what
 * lets the accelerated simulation tests run a whole night in milliseconds.
 */
export class WakeScheduler {
  private alarms: ScheduledAlarm[] = [];
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly opts: WakeSchedulerOptions) {}

  schedule(policy: AlarmPolicy, prayerTimeUtc: Date): ScheduledAlarm {
    const deadlineUtc = new Date(prayerTimeUtc.getTime() - policy.deadlineOffsetMinutes * MINUTE_MS);
    const alarm: ScheduledAlarm = {
      policy,
      prayerTimeUtc,
      deadlineUtc,
      windowStartUtc: new Date(deadlineUtc.getTime() - policy.windowMinutes * MINUTE_MS),
      fired: false,
    };
    // Replace any previous schedule for the same policy (e.g. after a settings change).
    this.alarms = this.alarms.filter((a) => a.policy.id !== policy.id);
    this.alarms.push(alarm);
    return alarm;
  }

  get scheduled(): readonly ScheduledAlarm[] {
    return this.alarms;
  }

  clear(): void {
    this.alarms = [];
  }

  /** Evaluate every armed alarm against the freshest data. Safe to call often. */
  async tick(): Promise<void> {
    if (this.ticking) return; // webhook + timer can overlap; decisions are idempotent anyway
    this.ticking = true;
    try {
      const now = this.opts.clock.now();
      for (const alarm of this.alarms) {
        if (alarm.fired || now < alarm.windowStartUtc) continue;
        const lookback = new Date(alarm.windowStartUtc.getTime() - 30 * MINUTE_MS);
        const samples = await this.opts.provider.getLatestSamples(alarm.policy.userId, lookback);
        const decision = decide({
          now,
          deadline: alarm.deadlineUtc,
          preferredStages: alarm.policy.preferredStages,
          samples,
          stalenessLimitMin: this.opts.stalenessLimitMin,
        });
        if (decision.action === 'fire') {
          alarm.fired = true;
          await this.opts.onFire(alarm, decision);
        }
      }
      // Drop alarms whose prayer time is well past.
      this.alarms = this.alarms.filter(
        (a) => !a.fired || now.getTime() < a.prayerTimeUtc.getTime() + 60 * MINUTE_MS,
      );
    } finally {
      this.ticking = false;
    }
  }

  startTicking(intervalMs = 30_000): void {
    this.stopTicking();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
