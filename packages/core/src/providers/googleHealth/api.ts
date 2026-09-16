import type { GhDataPoint, GhListDataPointsResponse } from './types.js';

/**
 * Minimal Google Health API v4 client (read-only): sleep sessions + heart rate.
 * Endpoint: GET https://health.googleapis.com/v4/users/me/dataTypes/{type}/dataPoints
 * Params: filter (AIP-160, only >= and <), pageSize (sleep max 25), pageToken.
 */

export const GOOGLE_HEALTH_BASE_URL = 'https://health.googleapis.com/v4';

export class GoogleHealthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GoogleHealthApiError';
  }
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

export interface GoogleHealthClientOptions {
  /** Returns a valid access token (see TokenManager). */
  getAccessToken: () => Promise<string>;
  /** Called once on a 401 to obtain a fresh token before the single retry. */
  onUnauthorized?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Backoff base for 429/5xx retries (ms). Tests set 0. */
  retryBaseMs?: number;
}

export interface SleepQuery {
  /** Sessions whose END time is at/after this instant (only end-time filtering is supported for sleep). */
  endTimeFromUtc: Date;
  endTimeToUtc?: Date;
  maxPages?: number; // × 25 rows
}

export interface HeartRateQuery {
  fromUtc: Date;
  toUtc?: Date;
  pageSize?: number; // default 1440, max 10000
  maxPages?: number;
}

const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function sleepFilter(q: SleepQuery): string {
  let f = `sleep.interval.end_time >= "${rfc3339(q.endTimeFromUtc)}"`;
  if (q.endTimeToUtc) f += ` AND sleep.interval.end_time < "${rfc3339(q.endTimeToUtc)}"`;
  return f;
}

export function heartRateFilter(q: HeartRateQuery): string {
  let f = `heart_rate.sample_time.physical_time >= "${rfc3339(q.fromUtc)}"`;
  if (q.toUtc) f += ` AND heart_rate.sample_time.physical_time < "${rfc3339(q.toUtc)}"`;
  return f;
}

export class GoogleHealthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: GoogleHealthClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? GOOGLE_HEALTH_BASE_URL;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  listSleep(q: SleepQuery): Promise<GhDataPoint[]> {
    return this.listAll('sleep', sleepFilter(q), 25, q.maxPages ?? 4);
  }

  listHeartRate(q: HeartRateQuery): Promise<GhDataPoint[]> {
    return this.listAll('heart-rate', heartRateFilter(q), Math.min(q.pageSize ?? 1440, 10_000), q.maxPages ?? 5);
  }

  /** Raw single page — exposed for probes/tests. */
  async listPage(dataType: string, filter: string, pageSize: number, pageToken?: string): Promise<GhListDataPointsResponse> {
    const url = new URL(`${this.baseUrl}/users/me/dataTypes/${dataType}/dataPoints`);
    url.searchParams.set('filter', filter);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    return this.getJson<GhListDataPointsResponse>(url.toString());
  }

  private async listAll(dataType: string, filter: string, pageSize: number, maxPages: number): Promise<GhDataPoint[]> {
    const out: GhDataPoint[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listPage(dataType, filter, pageSize, token);
      out.push(...(res.dataPoints ?? []));
      token = res.nextPageToken || undefined;
      if (!token) break;
    }
    return out;
  }

  private async getJson<T>(url: string): Promise<T> {
    let token = await this.opts.getAccessToken();
    let retriedAuth = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (res.ok) return (await res.json()) as T;
      const body = await res.json().catch(() => undefined);
      if (res.status === 401 && !retriedAuth && this.opts.onUnauthorized) {
        retriedAuth = true;
        token = await this.opts.onUnauthorized();
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 3) {
        await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** attempt));
        continue;
      }
      throw new GoogleHealthApiError(`Google Health API ${res.status} for ${url.split('?')[0]}`, res.status, body);
    }
  }
}
