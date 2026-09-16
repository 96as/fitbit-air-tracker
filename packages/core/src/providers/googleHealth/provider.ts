import type { Clock, SleepSample, SleepSession } from '../../types.js';
import type { DateRange, SleepDataProvider } from '../types.js';
import { GoogleHealthClient } from './api.js';
import { mapHeartRate, mapSleep, toSamples, type GoogleSleepSession, type HeartRateSample } from './mapping.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface GoogleHealthProviderOptions {
  client: GoogleHealthClient;
  clock: Clock;
  /** Never hit the API more often than this (platform invariant: ≥ 60 s). */
  minPollIntervalMs?: number;
}

/** What the day-one experiment needs to know (docs/GOOGLE_HEALTH_API.md §5). */
export interface ProbeReport {
  checkedAtUtc: string;
  sessionsLast48h: number;
  newestSessionEndUtc?: string;
  newestStageEndUtc?: string;
  newestHeartRateUtc?: string;
  anyUnprocessedSession: boolean;
  /** Minutes between now and the newest stage / HR sample — the real "sync lag". */
  stageLagMin?: number;
  heartRateLagMin?: number;
}

/**
 * Real Fitbit Air data via the Google Health API, behind the same seam as the
 * mock. Sleep sessions are fetched by END time (the only filter the API
 * supports for sleep) from 12 h before `since`, so an in-progress night — if
 * the API exposes it (metadata.processed=false) — is picked up too.
 */
export class GoogleHealthProvider implements SleepDataProvider {
  readonly name = 'google_health' as const;
  private readonly minPoll: number;
  private cache?: { atMs: number; sinceMs: number; samples: SleepSample[] };

  constructor(private readonly opts: GoogleHealthProviderOptions) {
    this.minPoll = opts.minPollIntervalMs ?? 60_000;
  }

  async getLatestSamples(userId: string, since: Date): Promise<SleepSample[]> {
    const now = this.opts.clock.now();
    if (this.cache && now.getTime() - this.cache.atMs < this.minPoll && this.cache.sinceMs <= since.getTime()) {
      return this.cache.samples.filter((s) => new Date(s.tsUtc) >= since);
    }
    const [sleepPoints, hrPoints] = await Promise.all([
      this.opts.client.listSleep({ endTimeFromUtc: new Date(since.getTime() - 12 * HOUR_MS), maxPages: 2 }),
      this.opts.client.listHeartRate({ fromUtc: since, maxPages: 2 }),
    ]);
    const sessions = sleepPoints.map((dp) => mapSleep(dp, userId)).filter((s): s is GoogleSleepSession => Boolean(s));
    const hr = hrPoints.map(mapHeartRate).filter((h): h is HeartRateSample => Boolean(h));
    const samples = toSamples(sessions, hr, since);
    this.cache = { atMs: now.getTime(), sinceMs: since.getTime(), samples };
    return samples;
  }

  async getSessions(userId: string, range: DateRange): Promise<SleepSession[]> {
    const points = await this.opts.client.listSleep({
      endTimeFromUtc: range.startUtc,
      endTimeToUtc: new Date(range.endUtc.getTime() + 24 * HOUR_MS),
      maxPages: 8,
    });
    return points
      .map((dp) => mapSleep(dp, userId))
      .filter((s): s is GoogleSleepSession => Boolean(s))
      .sort((a, b) => b.startUtc.localeCompare(a.startUtc));
  }

  /** Freshness report: how live is the data right now? */
  async probe(userId: string): Promise<ProbeReport> {
    const now = this.opts.clock.now();
    const since48h = new Date(now.getTime() - 48 * HOUR_MS);
    const [sleepPoints, hrPoints] = await Promise.all([
      this.opts.client.listSleep({ endTimeFromUtc: since48h, maxPages: 2 }),
      this.opts.client.listHeartRate({ fromUtc: new Date(now.getTime() - 6 * HOUR_MS), maxPages: 2 }),
    ]);
    const sessions = sleepPoints.map((dp) => mapSleep(dp, userId)).filter((s): s is GoogleSleepSession => Boolean(s));
    const hr = hrPoints.map(mapHeartRate).filter((h): h is HeartRateSample => Boolean(h));
    const newestSession = sessions.map((s) => s.endUtc).sort().at(-1);
    const newestStage = sessions.flatMap((s) => s.stages.map((st) => st.endUtc)).sort().at(-1);
    const newestHr = hr.map((h) => h.tsUtc).sort().at(-1);
    const lag = (iso?: string) => (iso ? Math.round((now.getTime() - new Date(iso).getTime()) / MINUTE_MS) : undefined);
    return {
      checkedAtUtc: now.toISOString(),
      sessionsLast48h: sessions.length,
      newestSessionEndUtc: newestSession,
      newestStageEndUtc: newestStage,
      newestHeartRateUtc: newestHr,
      anyUnprocessedSession: sessions.some((s) => s.meta.processed === false),
      stageLagMin: lag(newestStage),
      heartRateLagMin: lag(newestHr),
    };
  }
}
