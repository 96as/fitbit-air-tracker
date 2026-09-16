export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';

export type Prayer =
  | 'fajr'
  | 'qiyam'
  | 'suhoor'
  | 'dhuhr'
  | 'asr'
  | 'maghrib'
  | 'isha';

/** One normalized telemetry point from the tracker (per-minute resolution). */
export interface SleepSample {
  tsUtc: string; // ISO-8601 UTC
  stage: SleepStage;
  heartRateBpm?: number;
}

export interface SleepStageSegment {
  stage: SleepStage;
  startUtc: string;
  endUtc: string;
}

export interface SleepSession {
  id: string;
  userId: string;
  startUtc: string;
  endUtc: string;
  tzOffsetMin: number;
  isNap: boolean;
  efficiencyPct?: number;
  source: 'mock' | 'google_health';
  stages: SleepStageSegment[];
}

export interface AlarmPolicy {
  id: string;
  userId: string;
  prayer: Prayer;
  enabled: boolean;
  windowMinutes: number;
  deadlineOffsetMinutes: number;
  preferredStages: SleepStage[];
  snoozeMinutes: number;
  maxSnoozes: number;
}

export type FireReason = 'light-sleep' | 'hr-rise' | 'deadline';

export type Decision =
  | { action: 'fire'; reason: FireReason; detail?: string }
  | { action: 'wait'; detail?: string };

export interface User {
  id: string;
  email: string;
  tz: string; // IANA timezone
  lat: number;
  lng: number;
  calcMethod: number; // Aladhan method id
  madhab: 0 | 1; // 0 = Shafi, 1 = Hanafi
}

export interface PrayerTimetableEntry {
  id: string;
  userId: string;
  dateLocal: string; // YYYY-MM-DD in the user's timezone
  prayer: string; // Aladhan timing key, lowercased (fajr, sunrise, ..., lastthird)
  timeUtc: string;
}

export interface AlarmEvent {
  id: string;
  userId: string;
  policyId: string;
  type: 'scheduled' | 'fired' | 'snoozed' | 'dismissed';
  reason?: FireReason;
  tsUtc: string;
  detail?: Record<string, unknown>;
}

/** Injectable clock so the wake engine can be simulated at any speed. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * A wake alarm as configured by the user. `prayer` alarms anchor to a prayer
 * timing (deadline = prayer time − deadlineOffsetMinutes); `custom` alarms
 * anchor to a wall-clock time in the user's timezone (deadline = customTime).
 * Both get the same smart-wake window before the deadline (0 = exact alarm).
 */
export interface WakeAlarm extends AlarmPolicy {
  kind: 'prayer' | 'custom';
  label?: string;
  /** HH:MM local wall time — required when kind === 'custom'. */
  customTime?: string;
  /** Weekdays (0 = Sunday … 6 = Saturday). Undefined/empty = every day. */
  days?: number[];
}
