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

export interface GhHeartRate {
  sampleTime: GhObservationSampleTime;
  beatsPerMinute: string | number;
  metadata?: { motionContext?: string; sensorLocation?: string };
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
  dataSource?: GhDataSource;
}

export interface GhListDataPointsResponse {
  dataPoints?: GhDataPoint[];
  nextPageToken?: string;
}
