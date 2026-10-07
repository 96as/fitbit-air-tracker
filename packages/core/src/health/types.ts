/**
 * Shared health-data contract. Every data source (Google Health, mock, future
 * iPhone motion) fills a `NightData`; every metric reads one. All fields are
 * optional on purpose: we don't yet know which Fitbit Air data arrives in time,
 * so each metric has several methods and declares which inputs it needs.
 *
 * Timestamps are ISO-8601 UTC (`...Z`) like everywhere else in core.
 */
import type { SleepSession } from '../types.js';

export interface TimedValue {
  tsUtc: string;
  value: number;
}

export interface TimeInterval {
  startUtc: string;
  endUtc: string;
}

export interface HrvSample {
  tsUtc: string;
  rmssdMs?: number;
  sdnnMs?: number;
}

export interface MoodEntry {
  tsUtc: string;
  /** 1 = very bad … 5 = very good. */
  score: 1 | 2 | 3 | 4 | 5;
  /** Optional energy level, same 1–5 scale. */
  energy?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  note?: string;
}

/** Everything we know about one night (the sleep that ends on `dateLocal`). */
export interface NightData {
  /** Local calendar date (YYYY-MM-DD, user tz) the night ends on. */
  dateLocal: string;
  /** IANA timezone. */
  tz: string;

  /** Main sleep session with stages, if the provider has one. */
  session?: SleepSession;
  /** false = Google detected the sleep but stages are still processing. */
  stagesProcessed?: boolean;

  /** Heart rate samples (bpm), 1 s – 1 min resolution, covering the night. */
  heartRate?: TimedValue[];
  /** Per-sample HRV during the night. */
  hrv?: HrvSample[];
  /** Google's nightly HRV summary. */
  dailyHrv?: { rmssdMs?: number; deepSleepRmssdMs?: number; nonRemHrBpm?: number };
  restingHrBpm?: number;

  /** SpO2 samples (%). */
  spo2?: TimedValue[];
  dailySpo2?: { avgPct: number; lowerPct?: number; upperPct?: number };

  /** Breaths per minute during sleep. */
  respiratory?: { fullSleepBrpm?: number; lightBrpm?: number; deepBrpm?: number; remBrpm?: number };

  /** Nightly skin-temperature deviation from the personal baseline (°C). */
  skinTempDeltaC?: number;

  /** Step counts per minute (value = steps in that minute). */
  steps?: TimedValue[];
  /** Intervals the band reported as "still while worn". */
  stillPeriods?: TimeInterval[];
  /** Future: iPhone-on-mattress activity counts per minute. */
  phoneMotion?: TimedValue[];

  /** Mood check-ins logged in the app (usually the morning after). */
  mood?: MoodEntry[];
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * One metric computed by one method. A metric (e.g. `sleepScore`) may have
 * several results — one per method whose inputs were available — and the
 * engine picks a `best` one by confidence + method priority.
 */
export interface MetricResult {
  /** Stable metric id, e.g. 'sleepScore', 'recovery', 'sleepDebt'. */
  metric: string;
  /** Method id, e.g. 'stages-v1', 'hr-actigraphy-v1'. */
  method: string;
  /** null = method ran but could not produce a value. */
  value: number | null;
  unit?: string;
  confidence: Confidence;
  /** NightData field names this method used. */
  inputsUsed: string[];
  /** Plain-language, one sentence, for the dashboard and the AI summary. */
  explanation: string;
  /** Optional sub-scores / parts (0–100 or raw), for the breakdown UI. */
  components?: Record<string, number>;
  /**
   * ≤3-word plain status for the dashboard headline, e.g. recovery
   * "Train hard" | "Train light" | "Rest"; scores "Great" | "Good" | "Fair" | "Poor".
   */
  label?: string;
}

/** Rolling personal baselines (median of the last N nights, default 30). */
export interface Baselines {
  nights: number;
  restingHrBpm?: number;
  rmssdMs?: number;
  respiratoryBrpm?: number;
  spo2AvgPct?: number;
  sleepMinutes?: number;
  /** Median bedtime / wake time as minutes after local midnight (bedtime may be negative = before midnight). */
  bedtimeMin?: number;
  waketimeMin?: number;
  /** How many nights each baseline is built from (UI shows "still learning" below 14). */
  counts?: Partial<Record<'restingHrBpm' | 'rmssdMs' | 'respiratoryBrpm' | 'spo2AvgPct' | 'sleepMinutes' | 'bedtimeMin' | 'waketimeMin', number>>;
}

export interface MetricsReport {
  dateLocal: string;
  /** Every result, grouped by metric id. */
  all: Record<string, MetricResult[]>;
  /** The chosen result per metric id. */
  best: Record<string, MetricResult>;
  baselines: Baselines;
}
