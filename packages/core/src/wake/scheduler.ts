import type { AlarmPolicy, Clock, Decision, SleepSample } from '../types.js';
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
  /** Provider failures are reported here and never stop the deadline rule. */
  onError?: (error: unknown, alarm: ScheduledAlarm) => void;
  stalenessLimitMin?: number;
  /** Late-data cycle predictor (FireReason 'predicted-light'). Default true. */
  predictive?: boolean;
  /** How far before the window to fetch history for the predictor (minutes, default 600). */
  historyLookbackMin?: number;
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
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly opts: WakeSchedulerOptions) {}

  /** Arm an alarm anchored to a prayer time (deadline = prayer − offset). */
  schedule(policy: AlarmPolicy, prayerTimeUtc: Date): ScheduledAlarm {
    const deadlineUtc = new Date(prayerTimeUtc.getTime() - policy.deadlineOffsetMinutes * MINUTE_MS);
    return this.scheduleDeadline(policy, deadlineUtc, prayerTimeUtc);
  }

  /** Arm an alarm with an explicit hard deadline (custom wake times, demos). */
  scheduleDeadline(policy: AlarmPolicy, deadlineUtc: Date, prayerTimeUtc: Date = deadlineUtc): ScheduledAlarm {
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
        const predictive = this.opts.predictive !== false;
        const lookback = new Date(alarm.windowStartUtc.getTime() - 30 * MINUTE_MS);
        const historyFrom = predictive
          ? new Date(alarm.windowStartUtc.getTime() - (this.opts.historyLookbackMin ?? 600) * MINUTE_MS)
          : lookback;
        let history: SleepSample[] = [];
        try {
          history = await this.opts.provider.getLatestSamples(alarm.policy.userId, historyFrom);
        } catch (err) {
          // Invariant 1: a dead/unauthenticated provider degrades to "no data" —
          // the deadline still fires.
          this.opts.onError?.(err, alarm);
        }
        // The stage / HR-rise rules see exactly the short lookback they always did;
        // only the predictor gets the whole night.
        const samples = history.filter((s) => new Date(s.tsUtc).getTime() >= lookback.getTime());
        const decision = decide({
          now,
          deadline: alarm.deadlineUtc,
          preferredStages: alarm.policy.preferredStages,
          samples,
          stalenessLimitMin: this.opts.stalenessLimitMin,
          windowStart: alarm.windowStartUtc,
          history,
          predictive,
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
    (this.timer as { unref?: () => void }).unref?.(); // Node only; no-op on browsers/Hermes
  }

  stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
