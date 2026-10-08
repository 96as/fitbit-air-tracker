/**
 * TypeScript subset of the Google Health API v4 schemas we consume.
 * Source of truth: the official discovery document
 * https://health.googleapis.com/$discovery/rest?version=v4 (see docs/GOOGLE_HEALTH_API.md).
 * Note: protobuf int64 fields (beatsPerMinute, minutesAsleep, …) arrive as STRINGS.
 */

export type GhSleepStageType =
  | 'SLEEP_STAGE_TYPE_UNSPECIFIED'
  | 'AWAKE'
  | 'LIGHT'
  | 'DEEP'
  | 'REM'
  | 'ASLEEP'
  | 'RESTLESS';

export interface GhCivilDateTime {
  year?: number;
  month?: number;
  day?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export interface GhSessionTimeInterval {
  startTime: string; // RFC-3339
  endTime: string; // RFC-3339
  startUtcOffset?: string; // protobuf Duration, e.g. "10800s" (may also appear as "+03:00")
  endUtcOffset?: string;
  civilStartTime?: GhCivilDateTime;
  civilEndTime?: GhCivilDateTime;
}

export interface GhSleepStage {
  type: GhSleepStageType;
  startTime: string;
  endTime: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
}

export interface GhStageSummary {
  type: GhSleepStageType;
  minutes?: string;
  count?: string;
}

export interface GhSleepSummary {
  minutesAsleep?: string;
  minutesAwake?: string;
  minutesInSleepPeriod?: string;
  minutesToFallAsleep?: string;
  minutesAfterWakeUp?: string;
  stagesSummary?: GhStageSummary[];
}

export interface GhSleepMetadata {
  /** true = sleep + stages fully processed; false = sleep period detected, stages still processing. */
  processed?: boolean;
  nap?: boolean;
  mainSleep?: boolean;
  stagesStatus?: string;
  manuallyEdited?: boolean;
  externalId?: string;
}

export interface GhSleep {
  interval: GhSessionTimeInterval;
  type?: 'SLEEP_TYPE_UNSPECIFIED' | 'CLASSIC' | 'STAGES';
  stages?: GhSleepStage[];
  shortAwakenings?: GhSleepStage[];
  summary?: GhSleepSummary;
  metadata?: GhSleepMetadata;
  createTime?: string;
  updateTime?: string;
}

export interface GhObservationSampleTime {
  physicalTime: string; // RFC-3339
  utcOffset?: string;
  civilTime?: GhCivilDateTime;
}

export type GhMotionContext = 'MOTION_CONTEXT_UNSPECIFIED' | 'ACTIVE' | 'SEDENTARY';

export interface GhHeartRate {
  sampleTime: GhObservationSampleTime;
  beatsPerMinute: string | number;
  metadata?: { motionContext?: GhMotionContext | string; sensorLocation?: string };
}

/** google.type.Date — a calendar date in the user's timezone. */
export interface GhDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface GhObservationTimeInterval {
  startTime: string; // RFC-3339
  endTime: string; // RFC-3339
  startUtcOffset?: string; // Duration "10800s"
  endUtcOffset?: string;
  civilStartTime?: GhCivilDateTime;
  civilEndTime?: GhCivilDateTime;
}

/** `heart-rate-variability` (sample). Doubles arrive as JSON numbers. */
export interface GhHeartRateVariability {
  sampleTime: GhObservationSampleTime;
  rootMeanSquareOfSuccessiveDifferencesMilliseconds?: number;
  standardDeviationMilliseconds?: number;
  metadata?: { lowFrequencyPower?: number; highFrequencyPower?: number };
}

/** `daily-heart-rate-variability` (daily). nonRemHeartRateBeatsPerMinute is int64 → string. */
export interface GhDailyHeartRateVariability {
  date: GhDate;
  averageHeartRateVariabilityMilliseconds?: number;
  deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds?: number;
  nonRemHeartRateBeatsPerMinute?: string | number;
  entropy?: number;
}

/** `daily-resting-heart-rate` (daily). beatsPerMinute is int64 → string. */
export interface GhDailyRestingHeartRate {
  date: GhDate;
  beatsPerMinute: string | number;
  dailyRestingHeartRateMetadata?: { calculationMethod?: 'CALCULATION_METHOD_UNSPECIFIED' | 'WITH_SLEEP' | 'ONLY_WITH_AWAKE_DATA' | string };
}

/** `oxygen-saturation` (sample). */
export interface GhOxygenSaturation {
  sampleTime: GhObservationSampleTime;
  percentage: number;
}

/** `daily-oxygen-saturation` (daily, computed over the main sleep). */
export interface GhDailyOxygenSaturation {
  date: GhDate;
  averagePercentage: number;
  lowerBoundPercentage?: number;
  upperBoundPercentage?: number;
  standardDeviationPercentage?: number;
}

export interface GhRespiratoryRateStats {
  breathsPerMinute: number;
  standardDeviation?: number;
  signalToNoise?: number;
}

/** `respiratory-rate-sleep-summary` (sample; one per sleep, naps included). */
export interface GhRespiratoryRateSleepSummary {
  sampleTime: GhObservationSampleTime;
  fullSleepStats: GhRespiratoryRateStats;
  lightSleepStats?: GhRespiratoryRateStats;
  deepSleepStats?: GhRespiratoryRateStats;
  remSleepStats?: GhRespiratoryRateStats;
}

/** `daily-respiratory-rate` (daily, main sleep). */
export interface GhDailyRespiratoryRate {
  date: GhDate;
  breathsPerMinute: number;
}

/** `daily-sleep-temperature-derivations` (daily). */
export interface GhDailySleepTemperatureDerivations {
  date: GhDate;
  nightlyTemperatureCelsius: number;
  baselineTemperatureCelsius?: number;
  relativeNightlyStddev30dCelsius?: number;
}

/** `steps` (interval, 1-minute storage resolution). count is int64 → string. */
export interface GhSteps {
  interval: GhObservationTimeInterval;
  count: string | number;
}

/** `sedentary-period` (interval): not moving while wearing the device. */
export interface GhSedentaryPeriod {
  interval: GhObservationTimeInterval;
}

export interface GhDataSource {
  platform?: string;
  recordingMethod?: string;
  device?: Record<string, unknown>;
  application?: Record<string, unknown>;
}

export interface GhDataPoint {
  /** e.g. users/me/dataTypes/sleep/dataPoints/abc123 — stable id for identifiable types (sleep). */
  name?: string;
  sleep?: GhSleep;
  heartRate?: GhHeartRate;
  heartRateVariability?: GhHeartRateVariability;
  dailyHeartRateVariability?: GhDailyHeartRateVariability;
  dailyRestingHeartRate?: GhDailyRestingHeartRate;
  oxygenSaturation?: GhOxygenSaturation;
  dailyOxygenSaturation?: GhDailyOxygenSaturation;
  respiratoryRateSleepSummary?: GhRespiratoryRateSleepSummary;
  dailyRespiratoryRate?: GhDailyRespiratoryRate;
  dailySleepTemperatureDerivations?: GhDailySleepTemperatureDerivations;
  steps?: GhSteps;
  sedentaryPeriod?: GhSedentaryPeriod;
  dataSource?: GhDataSource;
}

export interface GhListDataPointsResponse {
  dataPoints?: GhDataPoint[];
  nextPageToken?: string;
}
