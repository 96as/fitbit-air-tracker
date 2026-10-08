import type { SleepSample, SleepSession } from '../types.js';

export interface DateRange {
  startUtc: Date;
  endUtc: Date;
}

/**
 * The seam between the wake engine and any sleep-data source.
 * Nothing outside src/providers/ may depend on a concrete implementation —
 * this is what lets the whole app run before Google Health API access is
 * approved (docs/ARCHITECTURE.md §2).
 */
export interface SleepDataProvider {
  readonly name: 'mock' | 'google_health';

  /**
   * Freshest telemetry visible to the cloud right now. Implementations must
   * honor real sync behavior: samples may trail wall time by many minutes.
   */
  getLatestSamples(userId: string, since: Date): Promise<SleepSample[]>;

  /** Completed sleep sessions (for history / dashboard / insights). */
  getSessions(userId: string, range: DateRange): Promise<SleepSession[]>;

  /** Register for change webhooks where the backend supports it. */
  subscribe?(userId: string): Promise<void>;
}
