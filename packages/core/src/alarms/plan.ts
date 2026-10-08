import type { WakeAlarm } from '../types.js';
import { nextOccurrence, timingKeyForPrayer, type TimingsByDate } from '../prayer/next.js';
import { addDays, localDateString, wallTimeToUtc, weekdayOfLocalDate } from '../util/tz.js';

export interface PlannedAlarm {
  alarmId: string;
  kind: WakeAlarm['kind'];
  label: string;
  prayerTimeUtc?: string;
  /** Hard deadline — the alarm MUST have fired by this instant. */
  deadlineUtc: string;
  /** Smart wake may fire from here on (== deadline when windowMinutes = 0). */
  windowStartUtc: string;
  /** Backup notification-chain instants (empty unless this is the next alarm). */
  chainTimesUtc: string[];
}

export interface ChainConfig {
  startDelaySec: number; // first backup after the deadline
  intervalSec: number;
  durationSec: number;
}

export interface PlanInput {
  alarms: WakeAlarm[];
  timings: TimingsByDate;
  tz: string;
  now: Date;
  /** How many local days ahead to pre-arm (device alarms survive app closure). */
  daysAhead?: number;
  chain?: ChainConfig;
}

export const DEFAULT_CHAIN: ChainConfig = { startDelaySec: 60, intervalSec: 30, durationSec: 600 };

const MINUTE_MS = 60_000;

/**
 * Pure planner: turns configured alarms + cached prayer timings into concrete
 * deadlines for the coming days, sorted soonest-first. The backup chain is
 * attached only to the next alarm so iOS's pending-notification cap (64) is
 * never approached.
 */
export function planAlarms(input: PlanInput): PlannedAlarm[] {
  const { alarms, timings, tz, now } = input;
  const daysAhead = input.daysAhead ?? 7;
  const chain = input.chain ?? DEFAULT_CHAIN;
  const planned: PlannedAlarm[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    for (let offset = 0; offset <= daysAhead; offset++) {
      const dateLocal = localDateString(addDays(now, offset), tz);
      if (alarm.days && alarm.days.length > 0 && !alarm.days.includes(weekdayOfLocalDate(dateLocal))) continue;

      let deadline: Date | undefined;
      let prayerTime: Date | undefined;
      if (alarm.kind === 'custom') {
        if (!alarm.customTime) continue;
        deadline = wallTimeToUtc(dateLocal, alarm.customTime, tz);
      } else {
        const iso = timings[dateLocal]?.[timingKeyForPrayer(alarm.prayer)];
        if (!iso) continue;
        prayerTime = new Date(iso);
        deadline = new Date(prayerTime.getTime() - alarm.deadlineOffsetMinutes * MINUTE_MS);
      }
      if (deadline.getTime() <= now.getTime()) continue;

      planned.push({
        alarmId: alarm.id,
        kind: alarm.kind,
        label: alarm.label ?? (alarm.kind === 'custom' ? `Alarm ${alarm.customTime}` : alarm.prayer),
        prayerTimeUtc: prayerTime?.toISOString(),
        deadlineUtc: deadline.toISOString(),
        windowStartUtc: new Date(deadline.getTime() - alarm.windowMinutes * MINUTE_MS).toISOString(),
        chainTimesUtc: [],
      });
    }
  }

  planned.sort((a, b) => a.deadlineUtc.localeCompare(b.deadlineUtc));
  const first = planned[0];
  if (first) first.chainTimesUtc = chainTimes(new Date(first.deadlineUtc), chain);
  return planned;
}

/** Backup ring instants after a deadline (the "chain of alarms"). */
export function chainTimes(deadline: Date, chain: ChainConfig = DEFAULT_CHAIN): string[] {
  const out: string[] = [];
  for (let t = chain.startDelaySec; t <= chain.startDelaySec + chain.durationSec; t += chain.intervalSec) {
    out.push(new Date(deadline.getTime() + t * 1000).toISOString());
  }
  return out;
}

/** The soonest planned alarm whose deadline is still ahead of `now`. */
export function nextPlanned(planned: PlannedAlarm[], now: Date): PlannedAlarm | undefined {
  return planned.find((p) => new Date(p.deadlineUtc) > now);
}

export { nextOccurrence };
